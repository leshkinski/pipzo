import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupExplicitDragScroll } from "./explicitDragScroll";

type Listener = (event: any) => void;

class FakeElement {
  scrollLeft = 0;
  scrollTop = 0;
  scrollWidth = 100;
  scrollHeight = 200;
  clientWidth = 100;
  clientHeight = 100;
  parentElement: FakeElement | null = null;
  private dragScroll: boolean;

  constructor(dragScroll = true) {
    this.dragScroll = dragScroll;
  }

  closest(selector: string): FakeElement | null {
    if (selector === "[data-drag-scroll]") {
      return this.dragScroll ? this : this.parentElement?.closest(selector) ?? null;
    }
    return null;
  }

  matches(selector: string) {
    return selector === "[data-drag-scroll]" && this.dragScroll;
  }
}

class FakeInputElement extends FakeElement {
  closest(selector: string): FakeElement | null {
    if (selector.startsWith("input,")) {
      return this;
    }
    return super.closest(selector);
  }
}

class FakeImageElement extends FakeElement {}

class FakeRoot extends FakeElement {
  listeners = new Map<string, Listener[]>();
  capturedPointerIds: number[] = [];
  releasedPointerIds: number[] = [];

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener));
  }

  setPointerCapture(pointerId: number) {
    this.capturedPointerIds.push(pointerId);
  }

  releasePointerCapture(pointerId: number) {
    this.releasedPointerIds.push(pointerId);
  }

  contains(element?: FakeElement) {
    let current: FakeElement | null | undefined = element ?? this;
    while (current) {
      if (current === this) {
        return true;
      }
      current = current.parentElement;
    }
    return true;
  }

  dispatch(type: string, event: Record<string, unknown>) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe("explicit drag scroll", () => {
  const originalElement = globalThis.Element;
  const originalHtmlElement = globalThis.HTMLElement;
  const originalHtmlImageElement = globalThis.HTMLImageElement;

  beforeEach(() => {
    vi.useFakeTimers();
    // @ts-expect-error Tests provide only the Element behavior the drag utility needs.
    globalThis.Element = FakeElement;
    // @ts-expect-error Tests provide only the HTMLElement behavior the drag utility needs.
    globalThis.HTMLElement = FakeElement;
    // @ts-expect-error Tests provide only the image instance check the drag utility needs.
    globalThis.HTMLImageElement = FakeImageElement;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.Element = originalElement;
    globalThis.HTMLElement = originalHtmlElement;
    globalThis.HTMLImageElement = originalHtmlImageElement;
  });

  it("waits for the movement threshold before changing scrollTop or suppressing clicks", () => {
    const root = new FakeRoot();
    const scrollTarget = new FakeElement();
    const child = new FakeElement(false);
    scrollTarget.parentElement = root;
    child.parentElement = scrollTarget;
    setupExplicitDragScroll(root as unknown as HTMLElement);
    const preventDefault = vi.fn();

    root.dispatch("pointerdown", { target: child, clientX: 40, clientY: 100, pointerId: 1, pointerType: "touch" });
    root.dispatch("pointermove", { clientX: 40, clientY: 95, pointerId: 1, preventDefault });
    root.dispatch("pointerup", { pointerId: 1 });
    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    root.dispatch("click", click);

    expect(scrollTarget.scrollTop).toBe(0);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(click.preventDefault).not.toHaveBeenCalled();
    expect(click.stopPropagation).not.toHaveBeenCalled();
    expect(root.capturedPointerIds).toEqual([]);
  });

  it("converts vertical touch drag distance into scrollTop and suppresses the drag click", () => {
    const root = new FakeRoot();
    const scrollTarget = new FakeElement();
    scrollTarget.scrollTop = 40;
    const child = new FakeElement(false);
    scrollTarget.parentElement = root;
    child.parentElement = scrollTarget;
    setupExplicitDragScroll(root as unknown as HTMLElement);
    const preventDefault = vi.fn();

    root.dispatch("pointerdown", { target: child, clientX: 40, clientY: 100, pointerId: 7, pointerType: "touch" });
    root.dispatch("pointermove", { clientX: 40, clientY: 82, pointerId: 7, preventDefault });
    root.dispatch("pointermove", { clientX: 40, clientY: 72, pointerId: 7, preventDefault });
    root.dispatch("pointerup", { pointerId: 7 });
    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    root.dispatch("click", click);

    expect(scrollTarget.scrollTop).toBe(68);
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(click.preventDefault).toHaveBeenCalledTimes(1);
    expect(click.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("converts mouse-style pointer drag distance into scrollTop on marked regions", () => {
    const root = new FakeRoot();
    const scrollTarget = new FakeElement();
    scrollTarget.scrollTop = 30;
    const child = new FakeElement(false);
    scrollTarget.parentElement = root;
    child.parentElement = scrollTarget;
    setupExplicitDragScroll(root as unknown as HTMLElement);
    const preventDefault = vi.fn();

    root.dispatch("pointerdown", { target: child, clientX: 40, clientY: 100, pointerId: 8, pointerType: "mouse" });
    root.dispatch("pointermove", { clientX: 40, clientY: 85, pointerId: 8, preventDefault });
    root.dispatch("pointermove", { clientX: 40, clientY: 75, pointerId: 8, preventDefault });

    expect(scrollTarget.scrollTop).toBe(55);
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });

  it("converts horizontal card touch drag distance into scrollLeft on marked rails", () => {
    const root = new FakeRoot();
    const rail = new FakeElement();
    rail.scrollLeft = 50;
    rail.scrollWidth = 420;
    rail.clientWidth = 180;
    rail.scrollHeight = 100;
    rail.clientHeight = 100;
    const card = new FakeElement(false);
    rail.parentElement = root;
    card.parentElement = rail;
    setupExplicitDragScroll(root as unknown as HTMLElement);
    const preventDefault = vi.fn();

    root.dispatch("touchstart", { target: card, touches: [{ clientX: 180, clientY: 90 }] });
    root.dispatch("touchmove", { touches: [{ clientX: 150, clientY: 92 }], preventDefault });
    root.dispatch("touchmove", { touches: [{ clientX: 110, clientY: 92 }], preventDefault });
    root.dispatch("touchend", {});
    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    root.dispatch("click", click);

    expect(rail.scrollLeft).toBe(120);
    expect(rail.scrollTop).toBe(0);
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(click.preventDefault).toHaveBeenCalledTimes(1);
    expect(click.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("routes vertical pulls on horizontal rail cards to the scrollable page surface", () => {
    const root = new FakeRoot();
    const surface = new FakeElement();
    surface.scrollTop = 20;
    surface.scrollHeight = 520;
    surface.clientHeight = 180;
    const rail = new FakeElement();
    rail.scrollLeft = 50;
    rail.scrollWidth = 420;
    rail.clientWidth = 180;
    rail.scrollHeight = 100;
    rail.clientHeight = 100;
    const card = new FakeElement(false);
    surface.parentElement = root;
    rail.parentElement = surface;
    card.parentElement = rail;
    setupExplicitDragScroll(root as unknown as HTMLElement);
    const preventDefault = vi.fn();

    root.dispatch("touchstart", { target: card, touches: [{ clientX: 180, clientY: 120 }] });
    root.dispatch("touchmove", { touches: [{ clientX: 178, clientY: 82 }], preventDefault });

    expect(surface.scrollTop).toBe(58);
    expect(rail.scrollLeft).toBe(50);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("does not suppress mouse pointer clicks until movement crosses the drag threshold", () => {
    const root = new FakeRoot();
    const scrollTarget = new FakeElement();
    const child = new FakeElement(false);
    scrollTarget.parentElement = root;
    child.parentElement = scrollTarget;
    setupExplicitDragScroll(root as unknown as HTMLElement);
    const preventDefault = vi.fn();

    root.dispatch("pointerdown", { target: child, clientX: 40, clientY: 100, pointerId: 9, pointerType: "mouse" });
    root.dispatch("pointermove", { clientX: 40, clientY: 94, pointerId: 9, preventDefault });
    root.dispatch("pointerup", { pointerId: 9 });
    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    root.dispatch("click", click);

    expect(scrollTarget.scrollTop).toBe(0);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(click.preventDefault).not.toHaveBeenCalled();
    expect(click.stopPropagation).not.toHaveBeenCalled();
  });

  it("suppresses mouse pointer clicks only after an actual drag", () => {
    const root = new FakeRoot();
    const scrollTarget = new FakeElement();
    const child = new FakeElement(false);
    scrollTarget.parentElement = root;
    child.parentElement = scrollTarget;
    setupExplicitDragScroll(root as unknown as HTMLElement);

    root.dispatch("pointerdown", { target: child, clientX: 40, clientY: 100, pointerId: 10, pointerType: "mouse" });
    root.dispatch("pointermove", { clientX: 40, clientY: 80, pointerId: 10, preventDefault: vi.fn() });
    root.dispatch("pointerup", { pointerId: 10 });
    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    root.dispatch("click", click);

    expect(click.preventDefault).toHaveBeenCalledTimes(1);
    expect(click.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("does not start drag scrolling from text inputs", () => {
    const root = new FakeRoot();
    const scrollTarget = new FakeElement();
    const input = new FakeInputElement(false);
    scrollTarget.parentElement = root;
    input.parentElement = scrollTarget;
    setupExplicitDragScroll(root as unknown as HTMLElement);
    const preventDefault = vi.fn();

    root.dispatch("pointerdown", { target: input, clientX: 40, clientY: 100, pointerId: 2, pointerType: "touch" });
    root.dispatch("pointermove", { clientX: 40, clientY: 60, pointerId: 2, preventDefault });

    expect(scrollTarget.scrollTop).toBe(0);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("falls back from a marked non-scrollable child to the scrollable parent region", () => {
    const root = new FakeRoot();
    const surface = new FakeElement();
    const sideStack = new FakeElement();
    const row = new FakeElement(false);
    sideStack.scrollHeight = 100;
    sideStack.clientHeight = 100;
    surface.parentElement = root;
    sideStack.parentElement = surface;
    row.parentElement = sideStack;
    setupExplicitDragScroll(root as unknown as HTMLElement);

    root.dispatch("pointerdown", { target: row, clientX: 40, clientY: 100, pointerId: 3, pointerType: "touch" });
    root.dispatch("pointermove", { clientX: 40, clientY: 70, pointerId: 3, preventDefault: vi.fn() });

    expect(sideStack.scrollTop).toBe(0);
    expect(surface.scrollTop).toBe(30);
  });

  it("prevents native browser image dragging without suppressing clicks", () => {
    const root = new FakeRoot();
    const image = new FakeImageElement(false);
    image.parentElement = root;
    setupExplicitDragScroll(root as unknown as HTMLElement);
    const dragStart = { target: image, preventDefault: vi.fn() };
    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };

    root.dispatch("dragstart", dragStart);
    root.dispatch("click", click);

    expect(dragStart.preventDefault).toHaveBeenCalledTimes(1);
    expect(click.preventDefault).not.toHaveBeenCalled();
    expect(click.stopPropagation).not.toHaveBeenCalled();
  });

  it("converts horizontal drag distance into scrollLeft on horizontal rails", () => {
    const root = new FakeRoot();
    const scrollTarget = new FakeElement();
    scrollTarget.scrollLeft = 60;
    scrollTarget.scrollWidth = 300;
    scrollTarget.clientWidth = 100;
    scrollTarget.scrollHeight = 100;
    const child = new FakeElement(false);
    scrollTarget.parentElement = root;
    child.parentElement = scrollTarget;
    setupExplicitDragScroll(root as unknown as HTMLElement);
    const preventDefault = vi.fn();

    root.dispatch("pointerdown", { target: child, clientX: 100, clientY: 80, pointerId: 11, pointerType: "mouse" });
    root.dispatch("pointermove", { clientX: 70, clientY: 82, pointerId: 11, preventDefault });
    root.dispatch("pointermove", { clientX: 50, clientY: 82, pointerId: 11, preventDefault });

    expect(scrollTarget.scrollLeft).toBe(110);
    expect(scrollTarget.scrollTop).toBe(0);
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(root.capturedPointerIds).toEqual([11]);
  });
});
