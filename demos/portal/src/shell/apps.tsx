import type { Component } from "solid-js";
import type { IAppInfo } from "../portal/apps";
import type { IAppId, IPortal } from "../portal/Portal";
import type { IRestoreProps } from "./RestoreBanner";
import { AquariumDot, AquariumStatus, AquariumView } from "../aquarium/AquariumView";
import { ChatBadge, ChatStatus, ChatView } from "../chat/ChatView";
import { APPS } from "../portal/apps";
import { PlannerDot, PlannerNav, PlannerRecover, PlannerSummary, PlannerView } from "../trips/PlannerView";

export interface IAppViewProps {
	portal: IPortal;
	tourStep: number | null;
	restore: IRestoreProps;
}

export interface IAppViews {
	Status: Component<{
		portal: IPortal;
	}>;
	Badge: Component<{
		portal: IPortal;
	}>;
	Nav?: Component<{
		portal: IPortal;
		active: boolean;
		onShow: () => void;
	}>;
	View: Component<IAppViewProps>;
	Recover?: Component<{
		portal: IPortal;
	}>;
}

const VIEWS: Record<IAppId, IAppViews> = {
	trips: {
		Status: (props) => <PlannerSummary state={props.portal.Trips} />,
		Badge: (props) => <PlannerDot state={props.portal.Trips} />,
		Nav: (props) => <PlannerNav state={props.portal.Trips} active={props.active} onShow={props.onShow} />,
		View: (props) => <PlannerView state={props.portal.Trips} tourStep={props.tourStep} restore={props.restore} />,
		Recover: (props) => <PlannerRecover state={props.portal.Trips} />
	},
	aquarium: {
		Status: (props) => <AquariumStatus state={props.portal.Aquarium} />,
		Badge: (props) => <AquariumDot state={props.portal.Aquarium} />,
		View: (props) => <AquariumView state={props.portal.Aquarium} restore={props.restore} />
	},
	chat: {
		Status: (props) => <ChatStatus state={props.portal.Chat} />,
		Badge: (props) => <ChatBadge state={props.portal.Chat} />,
		View: (props) => <ChatView state={props.portal.Chat} restore={props.restore} />
	}
};

export const APP_VIEWS: readonly (IAppInfo & IAppViews)[] = APPS.map((app) => ({
	...app,
	...VIEWS[app.Id]
}));
