import type { ReactNode } from "react";
import { Component } from "react";

interface IGuardedProps {
	name: string;
	/** A failed view tries again when any of these changes from what it was at the failure. */
	retryOn?: readonly unknown[];
	fallback: (retry: () => void) => ReactNode;
	children: ReactNode;
}

function same(a: readonly unknown[], b: readonly unknown[]): boolean {
	return a.length === b.length && a.every((value, at) => Object.is(value, b[at]));
}

export class Guarded extends Component<
	IGuardedProps,
	{
		failed: boolean;
	}
> {
	state = {
		failed: false
	};

	private failedAt: readonly unknown[] | undefined;

	static getDerivedStateFromError() {
		return {
			failed: true
		};
	}

	componentDidCatch(error: unknown) {
		console.error(`[portal] the ${this.props.name} failed:`, error);
		this.failedAt = this.props.retryOn;
	}

	componentDidUpdate() {
		const at = this.failedAt;
		const now = this.props.retryOn;
		if (this.state.failed && at && now && !same(at, now)) this.retry();
	}

	retry = (): void => {
		this.failedAt = undefined;
		this.setState({
			failed: false
		});
	};

	render() {
		return this.state.failed ? this.props.fallback(this.retry) : this.props.children;
	}
}
