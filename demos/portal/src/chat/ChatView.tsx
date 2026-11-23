import type { IRestoreProps } from "../shell/RestoreBanner";
import type { IChatRow } from "./Chat";
import { createEffect, createSignal, For, onSettled, Show, untrack } from "solid-js";
import { RestoreBanner } from "../shell/RestoreBanner";
import { focusChatHalf } from "../shell/responsive";
import { sendable } from "./Conversation";
import { Chat, Conversation, Message } from "./contexts";
import { conversationLabel, person } from "./directory";
import { LETTER_FADE_MS, lettersAfter, voucherButton } from "./Message";

function Avatar(props: { id: string }) {
	return (
		<span
			class="pa"
			style={{
				background: person(props.id).Colour
			}}
		>
			{person(props.id).Initials}
		</span>
	);
}

function Row(props: { row: IChatRow; onOpen: () => void }) {
	return (
		<button
			type="button"
			class={[
				"ch",
				{
					on: props.row.On,
					unread: props.row.Bold
				}
			]}
			onClick={() => props.onOpen()}
		>
			<Show
				when={props.row.Channel}
				fallback={
					<span
						class={[
							"pa",
							{
								on: props.row.Online
							}
						]}
						style={{
							background: props.row.Colour
						}}
					>
						{props.row.Initials}
					</span>
				}
			>
				<span class="h">#</span>
			</Show>
			<span class="nm">{props.row.Name}</span>
			<Show when={props.row.Note}>
				<span class="typ">{props.row.Note}</span>
			</Show>
			<Show when={props.row.Badge > 0}>
				<span class="n">{props.row.Badge}</span>
			</Show>
		</button>
	);
}

function MessageText(props: { text: string; streaming: boolean; arriving: boolean }) {
	const seen = untrack(() => (props.arriving ? 0 : props.text.length));
	const [fading, setFading] = createSignal(untrack(() => props.streaming));
	createEffect(
		() => props.streaming,
		(streaming) => {
			if (streaming || !fading()) return;
			const timer = setTimeout(() => setFading(false), LETTER_FADE_MS);
			return () => clearTimeout(timer);
		}
	);
	return (
		<Show when={fading()} fallback={props.text}>
			{props.text.slice(0, seen)}
			<For each={lettersAfter(props.text, seen)} keyed={false}>
				{(letter) => <span class="letter">{letter()}</span>}
			</For>
		</Show>
	);
}

const MessageRow = Message.provider<{
	day: string | null;
	arriving: boolean;
}>((props) => {
	const message = Message.use();
	const chat = Chat.use();
	const mine = () => message.state.From === "me";
	const voucher = () => voucherButton(message.state, chat.state.VoucherApplied);
	return (
		<>
			<Show when={props.day}>{(day) => <div class="day">{day()}</div>}</Show>
			<div
				class={[
					"m",
					{
						mine: mine(),
						streaming: message.state.Streaming,
						sending: message.sendStatus() === "sending",
						failed: message.sendStatus() === "failed"
					}
				]}
			>
				<Avatar id={message.state.From} />
				<div>
					<div class="who">
						{person(message.state.From).Name}
						<time>{message.state.At}</time>
					</div>
					<p>
						<MessageText text={message.state.Text} streaming={message.state.Streaming} arriving={props.arriving} />
						<Show when={message.state.Streaming}>
							<span class="caret" />
						</Show>
					</p>
					<Show when={voucher()}>
						{(button) => (
							<button
								type="button"
								class={[
									"btn voucher",
									{
										applied: button().Disabled
									}
								]}
								disabled={button().Disabled}
								onClick={() => chat.applyVoucher()}
							>
								{button().Label}
							</button>
						)}
					</Show>
					<Show when={message.sendStatus() === "sending"}>
						<div class="status">Sending…</div>
					</Show>
					<Show when={message.sendStatus() === "failed"}>
						<div class="status bad">
							Didn't send
							<button type="button" onClick={() => message.retry()}>
								Retry
							</button>
						</div>
					</Show>
				</div>
			</div>
		</>
	);
});

const ConversationPane = Conversation.provider(() => {
	const conversation = Conversation.use();
	const [draft, setDraft] = createSignal("");
	let mounted = false;
	onSettled(() => {
		mounted = true;
	});
	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		const text = draft();
		if (sendable(text) === null) return;
		setDraft("");
		void conversation.send(text);
	};
	return (
		<>
			<div class="msgs">
				<div class="msgs-in">
					<For each={conversation.state.Messages}>
						{(message, i) => <MessageRow state={message} day={conversation.dayBreaks()[i()] ?? null} arriving={mounted} />}
					</For>
				</div>
			</div>
			<div class="typing">
				<Show when={conversation.typing()}>
					<span class="dots">
						<i />
						<i />
						<i />
					</span>
					{conversation.typing()}
				</Show>
			</div>
			<form class="composer" onSubmit={submit}>
				<input
					value={draft()}
					onInput={(event) => setDraft(event.currentTarget.value)}
					placeholder={`Message ${conversationLabel(conversation.state.Key)}`}
					aria-label="Message"
				/>
				<span>Enter to send</span>
			</form>
		</>
	);
});

export const ChatView = Chat.provider<{
	restore: IRestoreProps;
}>((props) => {
	const chat = Chat.use();
	const [showPane, setShowPane] = createSignal(true);
	let root!: HTMLDivElement;
	const show = (pane: boolean) => {
		setShowPane(pane);
		focusChatHalf(root, pane);
	};
	const open = (id: string) => {
		show(true);
		void chat.openConversation(id);
	};
	let shownId = untrack(() => chat.current()?.$Id);
	createEffect(
		() => chat.current()?.$Id,
		(id) => {
			if (id !== undefined && shownId !== undefined && id !== shownId) show(true);
			shownId = id;
		}
	);
	return (
		<div
			ref={root}
			class={[
				"chat",
				{
					"show-pane": showPane()
				}
			]}
		>
			<div class="chans">
				<div>
					<div class="label">Channels</div>
					<For each={chat.rows().Channels}>{(row) => <Row row={row} onOpen={() => open(row.Id)} />}</For>
				</div>
				<div>
					<div class="label">Direct</div>
					<For each={chat.rows().Direct}>{(row) => <Row row={row} onOpen={() => open(row.Id)} />}</For>
				</div>
			</div>
			<div class="pane">
				<Show when={chat.paneHead()}>
					{(head) => (
						<div class="phead">
							<button type="button" class="pback" aria-label="All conversations" onClick={() => show(false)}>
								‹
							</button>
							<div class="ptitle" tabindex={-1}>
								<b>{head().Title}</b>
								<small>{head().Topic}</small>
							</div>
							<div class="faces">
								<For each={head().Faces}>
									{(face) => (
										<span
											class="pa"
											style={{
												background: face.Colour
											}}
										>
											{face.Initials}
										</span>
									)}
								</For>
							</div>
						</div>
					)}
				</Show>
				<Show when={props.restore.lines || chat.state.Intro}>
					<div class="pane-notes">
						<Show when={props.restore.lines}>
							<div class="app-banner">
								<RestoreBanner restore={props.restore} />
							</div>
						</Show>
						<Show when={chat.state.Intro}>
							<div class="intro">
								<span>
									<b>Your teammates here are simulated.</b> The demo's fake backend scripts what they say, and each message streams in
									letter by letter through a treflex stream resource.
								</span>
								<button type="button" class="btn" onClick={() => chat.dismissIntro()}>
									Got it
								</button>
							</div>
						</Show>
					</div>
				</Show>
				<Show when={chat.current()} keyed fallback={<div class="msgs" />}>
					{(conversation) => <ConversationPane state={conversation} />}
				</Show>
			</div>
		</div>
	);
});

export const ChatStatus = Chat.provider(() => {
	const chat = Chat.use();
	return <small>{chat.summary().Line}</small>;
});

export const ChatBadge = Chat.provider(() => {
	const chat = Chat.use();
	return (
		<Show when={chat.summary().Unread > 0}>
			<span class="count">{chat.summary().Unread}</span>
		</Show>
	);
});
