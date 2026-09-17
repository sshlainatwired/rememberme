import { describe, expect, test, vi } from "vitest";
import { publishSettingsChanged, subscribeSettingsChanged } from "./settings-events";

describe("settings change events", () => {
	test("publishes only to listeners bound to the same handle", () => {
		const first = { settings: null };
		const second = { settings: null };
		const firstListener = vi.fn();
		const secondListener = vi.fn();
		const unsubscribe = subscribeSettingsChanged(first, firstListener);
		const unsubscribeSecond = subscribeSettingsChanged(second, secondListener);
		publishSettingsChanged(first);
		expect(firstListener).toHaveBeenCalledOnce();
		expect(secondListener).not.toHaveBeenCalled();
		unsubscribe();
		publishSettingsChanged(first);
		expect(firstListener).toHaveBeenCalledOnce();
		unsubscribeSecond();
	});

	test("isolates a throwing listener so committed writes and healthy peers continue", () => {
		const handle = { settings: null };
		const healthy = vi.fn();
		const unsubscribeThrowing = subscribeSettingsChanged(handle, () => {
			throw new Error("listener failure");
		});
		const unsubscribeHealthy = subscribeSettingsChanged(handle, healthy);
		expect(() => publishSettingsChanged(handle)).not.toThrow();
		expect(healthy).toHaveBeenCalledOnce();
		unsubscribeThrowing();
		unsubscribeHealthy();
	});

	test("can exclude the originating listener", () => {
		const handle = { settings: null };
		const origin = vi.fn();
		const peer = vi.fn();
		const unsubscribeOrigin = subscribeSettingsChanged(handle, origin);
		const unsubscribePeer = subscribeSettingsChanged(handle, peer);
		publishSettingsChanged(handle, origin);
		expect(origin).not.toHaveBeenCalled();
		expect(peer).toHaveBeenCalledOnce();
		unsubscribeOrigin();
		unsubscribePeer();
	});
});
