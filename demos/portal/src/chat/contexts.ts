import type { IChat } from "./Chat";
import type { IConversation } from "./Conversation";
import type { IMessage } from "./Message";
import { createEntityFeature } from "treflex-solid";
import * as ChatFeature from "./Chat";
import * as ConversationFeature from "./Conversation";
import * as MessageFeature from "./Message";

export const Chat = createEntityFeature<IChat>("Portal/Chat/Chat")(ChatFeature.actions, ChatFeature.selectors);

export const Conversation = createEntityFeature<IConversation>("Portal/Chat/Conversation")(
	ConversationFeature.actions,
	ConversationFeature.selectors
);

export const Message = createEntityFeature<IMessage>("Portal/Chat/Message")(MessageFeature.actions, MessageFeature.selectors);
