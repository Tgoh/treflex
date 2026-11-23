import type { IRestoreProps } from "../shell/RestoreBanner";
import type { IFish } from "./Fish";
import { createSignal, For, onSettled, Show, untrack } from "solid-js";
import { wallClock } from "../portal/clock";
import { RestoreBanner } from "../shell/RestoreBanner";
import { Aquarium } from "./contexts";
import { BUBBLES, GIANT_COLOUR, loopDelay, PHOTOPHORE_S, PHOTOPHORE_STAGGER_S, SNOW, schoolColour } from "./decoration";
import { swimInProgress } from "./Fish";

const PHOTOPHORE_X = [
	45,
	57,
	69
];
const PHOTOPHORE_Y = [
	39,
	41,
	40
];

function FishView(props: { state: IFish }) {
	const undulateDelay = untrack(() => loopDelay(props.state.Wobble));
	const tailDelay = untrack(() => loopDelay(props.state.Wobble * 0.5));
	return (
		<div
			class="fish-body"
			style={{
				"--hue": `${props.state.Hue}`,
				"--wobble": `${props.state.Wobble}s`,
				"--undulate-delay": `${undulateDelay}s`,
				"--tail-delay": `${tailDelay}s`,
				"--glow": `${props.state.Glow}px`,
				width: `${props.state.Length}px`,
				transform: `scaleX(${props.state.Facing})`
			}}
		>
			<svg class="fish-svg" viewBox="0 0 104 56" aria-hidden="true">
				<path class="fish-tail" d="M 24 28 L 3 11 L 13 28 L 3 45 Z" />
				<path class="fish-fin" d="M 49 11 Q 61 -1 73 13 Z" />
				<path class="fish-fin" d="M 51 45 Q 58 54 67 44 Z" />
				<path class="fish-core" d="M 24 28 C 37 8 75 8 93 28 C 75 48 37 48 24 28 Z" />
				<For each={PHOTOPHORE_X}>
					{(cx, i) => {
						const index = untrack(i);
						const delay = loopDelay(PHOTOPHORE_S, index * PHOTOPHORE_STAGGER_S);
						return (
							<circle
								class="photophore"
								cx={cx}
								cy={PHOTOPHORE_Y[index]}
								r="2.4"
								style={{
									"animation-delay": `${delay}s`
								}}
							/>
						);
					}}
				</For>
				<circle class="fish-eye" cx="84" cy="24" r="3.4" />
				<circle class="fish-glint" cx="85.4" cy="22.6" r="1.1" />
			</svg>
		</div>
	);
}

const pickUps: {
	slot: HTMLElement;
	run: () => void;
}[] = [];

// A slot's start position has to be in computed style before the move to X and Y, or the move starts
// no transition.
function afterStylePass(slot: HTMLElement, run: () => void): void {
	if (
		pickUps.push({
			slot,
			run
		}) > 1
	)
		return;
	queueMicrotask(() => {
		const queued = pickUps.splice(0);
		for (const each of queued) void getComputedStyle(each.slot).transform;
		for (const each of queued) each.run();
	});
}

function Swimmer(props: { fish: IFish; title: string; arriving: boolean; onRelease: () => void }) {
	const arriving = untrack(() => props.arriving);
	const swim = untrack(() => swimInProgress(props.fish, wallClock()));
	const swimTo = untrack(() => [
		props.fish.X,
		props.fish.Y
	]);
	const [holding, setHolding] = createSignal(swim !== null);
	const [delay, setDelay] = createSignal(0);
	let slot!: HTMLDivElement;
	onSettled(() => {
		if (!swim) return;
		afterStylePass(slot, () => {
			setDelay(swim.Elapsed);
			setHolding(false);
		});
	});
	const resuming = () => delay() > 0 && props.fish.X === swimTo[0] && props.fish.Y === swimTo[1];
	return (
		<div
			ref={slot}
			class={[
				"fish-slot",
				{
					arriving,
					holding: holding()
				}
			]}
			style={{
				"--fish-x": `${holding() && swim ? swim.FromX : props.fish.X}`,
				"--fish-y": `${holding() && swim ? swim.FromY : props.fish.Y}`,
				"transition-delay": resuming() ? `${-delay()}ms` : undefined
			}}
		>
			<button type="button" class="fish-inner" onClick={() => props.onRelease()} title={props.title}>
				<FishView state={props.fish} />
			</button>
		</div>
	);
}

export const AquariumView = Aquarium.provider<{
	restore: IRestoreProps;
}>((props) => {
	const aquarium = Aquarium.use();
	const facts = () => aquarium.tankFacts();
	let mounted = false;
	onSettled(() => {
		mounted = true;
	});

	return (
		<>
			<div class="top">
				<div class="crumbs">
					<b>Aquarium</b>
				</div>
				<div class="btns">
					<button type="button" class="btn" disabled={!facts().CanAddGiant} onClick={() => aquarium.addGiant()}>
						Release a giant
					</button>
					<button type="button" class="btn dark" disabled={!facts().CanAddSchool} onClick={() => aquarium.addSchool()}>
						+ Add a school
					</button>
				</div>
			</div>
			<Show when={props.restore.lines}>
				<div class="app-banner">
					<RestoreBanner restore={props.restore} />
				</div>
			</Show>
			<div class="tank">
				<div class="rays" />
				<div class="floor" />
				<For each={SNOW}>
					{(p) => {
						const delay = loopDelay(p.dur, p.delay);
						return (
							<div
								class="snow"
								style={{
									left: `${p.x}%`,
									width: `${p.size}px`,
									height: `${p.size}px`,
									"--dur": `${p.dur}s`,
									"--delay": `${delay}s`,
									"--drift": `${p.drift}px`
								}}
							/>
						);
					}}
				</For>
				<For each={BUBBLES}>
					{(b) => {
						const delay = loopDelay(b.dur, b.delay);
						return (
							<div
								class="bubble"
								style={{
									left: `${b.x}%`,
									width: `${b.size}px`,
									height: `${b.size}px`,
									"--dur": `${b.dur}s`,
									"--delay": `${delay}s`
								}}
							/>
						);
					}}
				</For>
				<For each={aquarium.state.Schools}>
					{(school) => (
						<div class="school-layer">
							<For each={school.Fish}>
								{(fish) => (
									<Swimmer
										fish={fish}
										title="Release this fish"
										arriving={mounted}
										onRelease={() => aquarium.releaseFish(school.$Id, fish.$Id)}
									/>
								)}
							</For>
						</div>
					)}
				</For>
				<div class="giant-layer">
					<For each={aquarium.state.Giants}>
						{(giant) => (
							<Swimmer fish={giant} title="Release this giant" arriving={mounted} onRelease={() => aquarium.releaseGiant(giant.$Id)} />
						)}
					</For>
				</div>
				<div class="tankbar">
					<span>{facts().Bar}</span>
					<span>{aquarium.swimLine()}</span>
				</div>
				<div class="schools">
					<For each={aquarium.state.Schools}>
						{(school) => (
							<span class="school">
								<i
									style={{
										background: schoolColour(school.Hue)
									}}
								/>
								{school.Name} · {school.Fish.length}
								<button
									type="button"
									disabled={!facts().CanAddFish}
									onClick={() => aquarium.addFish(school.$Id)}
									title="Add a fish to this school"
								>
									+
								</button>
								<button
									type="button"
									onClick={() => aquarium.releaseSchool(school.$Id)}
									title="Release this school, and every fish in it with it"
								>
									×
								</button>
							</span>
						)}
					</For>
					<Show when={facts().Giants}>
						<span class="school">
							<i
								style={{
									background: GIANT_COLOUR
								}}
							/>
							{facts().Giants}
						</span>
					</Show>
				</div>
			</div>
		</>
	);
});

export const AquariumStatus = Aquarium.provider(() => {
	const aquarium = Aquarium.use();
	return <small>{aquarium.tankFacts().Line}</small>;
});

export const AquariumDot = Aquarium.provider(() => {
	const aquarium = Aquarium.use();
	return (
		<Show when={aquarium.tankFacts().Fish > 0}>
			<span class="dot" />
		</Show>
	);
});
