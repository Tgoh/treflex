import type { IChat } from "../../../portal/src/chat/Chat";
import type { IConversation } from "../../../portal/src/chat/Conversation";
import type { IMessage } from "../../../portal/src/chat/Message";
import { createEntityFeature } from "treflex-react";
import * as ChatFeature from "../../../portal/src/chat/Chat";
import * as ConversationFeature from "../../../portal/src/chat/Conversation";
import * as MessageFeature from "../../../portal/src/chat/Message";

export const Chat = createEntityFeature<IChat>("Portal/Chat/Chat")(ChatFeature.actions, ChatFeature.selectors);

export const Conversation = createEntityFeature<IConversation>("Portal/Chat/Conversation")(
	ConversationFeature.actions,
	ConversationFeature.selectors
);

export const Message = createEntityFeature<IMessage>("Portal/Chat/Message")(MessageFeature.actions, MessageFeature.selectors);
