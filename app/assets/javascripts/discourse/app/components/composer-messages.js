import Component from "@ember/component";
import EmberObject from "@ember/object";
import I18n from "I18n";
import LinkLookup from "discourse/lib/link-lookup";
import { not } from "@ember/object/computed";
import { scheduleOnce } from "@ember/runloop";
import showModal from "discourse/lib/show-modal";

let _messagesCache = {};

export default Component.extend({
  classNameBindings: [":composer-popup-container", "hidden"],
  checkedMessages: false,
  messages: null,
  messagesByTemplate: null,
  queuedForTyping: null,
  _lastSimilaritySearch: null,
  _similarTopicsMessage: null,
  _yourselfConfirm: null,
  similarTopics: null,

  hidden: not("composer.viewOpenOrFullscreen"),

  didInsertElement() {
    this._super(...arguments);
    this.appEvents.on("composer:typed-reply", this, this._typedReply);
    this.appEvents.on("composer:opened", this, this._findMessages);
    this.appEvents.on("composer:find-similar", this, this._findSimilar);
    this.appEvents.on("composer-messages:close", this, this._closeTop);
    this.appEvents.on("composer-messages:create", this, this._create);
    scheduleOnce("afterRender", this, this.reset);
  },

  willDestroyElement() {
    this.appEvents.off("composer:typed-reply", this, this._typedReply);
    this.appEvents.off("composer:opened", this, this._findMessages);
    this.appEvents.off("composer:find-similar", this, this._findSimilar);
    this.appEvents.off("composer-messages:close", this, this._closeTop);
    this.appEvents.off("composer-messages:create", this, this._create);
  },

  _closeTop() {
    const messages = this.messages;
    messages.popObject();
    this.set("messageCount", messages.get("length"));
  },

  _removeMessage(message) {
    const messages = this.messages;
    messages.removeObject(message);
    this.set("messageCount", messages.get("length"));
  },

  actions: {
    closeMessage(message) {
      this._removeMessage(message);
    },

    hideMessage(message) {
      this._removeMessage(message);
      // kind of hacky but the visibility depends on this
      this.messagesByTemplate[message.get("templateName")] = undefined;
    },

    popup(message) {
      const messagesByTemplate = this.messagesByTemplate;
      const templateName = message.get("templateName");

      if (!messagesByTemplate[templateName]) {
        const messages = this.messages;
        messages.pushObject(message);
        this.set("messageCount", messages.get("length"));
        messagesByTemplate[templateName] = message;
      }
    },

    shareModal() {
      const { topic } = this.composer;
      const controller = showModal("share-topic");
      controller.setProperties({
        allowInvites:
          topic.details.can_invite_to &&
          !topic.archived &&
          !topic.closed &&
          !topic.deleted,
        topic: topic,
      });
    },
  },

  // Resets all active messages.
  // For example if composing a new post.
  reset() {
    if (this.isDestroying || this.isDestroyed) {
      return;
    }
    this.setProperties({
      messages: [],
      messagesByTemplate: {},
      queuedForTyping: [],
      checkedMessages: false,
      similarTopics: [],
    });
  },

  // Called after the user has typed a reply.
  // Some messages only get shown after being typed.
  _typedReply() {
    if (this.isDestroying || this.isDestroyed) {
      return;
    }

    const composer = this.composer;
    if (composer.get("privateMessage")) {
      const recipients = composer.targetRecipientsArray;

      if (
        recipients.length > 0 &&
        recipients.every((r) => r.name === this.currentUser.get("username"))
      ) {
        const message =
          this._yourselfConfirm ||
          composer.store.createRecord("composer-message", {
            id: "yourself_confirm",
            templateName: "custom-body",
            title: I18n.t("composer.yourself_confirm.title"),
            body: I18n.t("composer.yourself_confirm.body"),
          });
        this.send("popup", message);
      }
    }

    this.queuedForTyping.forEach((msg) => this.send("popup", msg));
  },

  _create(info) {
    this.reset();
    this.send("popup", EmberObject.create(info));
  },

  _findSimilar() {
    const composer = this.composer;

    // We don't care about similar topics unless creating a topic
    if (!composer.get("creatingTopic")) {
      return;
    }

    // TODO pass the 200 in from somewhere
    const raw = (composer.get("reply") || "").substr(0, 200);
    const title = composer.get("title") || "";

    // Ensure we have at least a title
    if (title.length < this.siteSettings.min_title_similar_length) {
      return;
    }

    // Don't search over and over
    const concat = title + raw;
    if (concat === this._lastSimilaritySearch) {
      return;
    }
    this._lastSimilaritySearch = concat;

    const similarTopics = this.similarTopics;
    const message =
      this._similarTopicsMessage ||
      composer.store.createRecord("composer-message", {
        id: "similar_topics",
        templateName: "similar-topics",
        extraClass: "similar-topics",
      });

    this._similarTopicsMessage = message;

    composer.store.find("similar-topic", { title, raw }).then((topics) => {
      similarTopics.clear();
      similarTopics.pushObjects(topics.get("content"));

      if (similarTopics.get("length") > 0) {
        message.set("similarTopics", similarTopics);
        this.send("popup", message);
      } else if (message && !(this.isDestroyed || this.isDestroying)) {
        this.send("hideMessage", message);
      }
    });
  },

  // Figure out if there are any messages that should be displayed above the composer.
  _findMessages() {
    if (this.checkedMessages) {
      return;
    }

    const composer = this.composer;
    const args = { composer_action: composer.get("action") };
    const topicId = composer.get("topic.id");
    const postId = composer.get("post.id");

    if (topicId) {
      args.topic_id = topicId;
    }
    if (postId) {
      args.post_id = postId;
    }

    const cacheKey = `${args.composer_action}${args.topic_id}${args.post_id}`;

    const processMessages = (messages) => {
      if (this.isDestroying || this.isDestroyed) {
        return;
      }

      // Checking composer messages on replies can give us a list of links to check for
      // duplicates
      if (messages.extras && messages.extras.duplicate_lookup) {
        this.addLinkLookup(new LinkLookup(messages.extras.duplicate_lookup));
      }

      this.set("checkedMessages", true);
      const queuedForTyping = this.queuedForTyping;
      messages.forEach((msg) =>
        msg.wait_for_typing
          ? queuedForTyping.addObject(msg)
          : this.send("popup", msg)
      );
    };

    if (_messagesCache.cacheKey === cacheKey) {
      processMessages(_messagesCache.messages);
    } else {
      composer.store.find("composer-message", args).then((messages) => {
        _messagesCache = { messages, cacheKey };
        processMessages(messages);
      });
    }
  },
});
