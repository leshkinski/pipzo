import { useEffect, type RefObject } from "react";

const dragScrollSelector = "[data-drag-scroll]";
const dragThresholdPx = 8;

type DragState = {
  scrollTarget: HTMLElement;
  startY: number;
  lastY: number;
  dragging: boolean;
  suppressClick: boolean;
  pointerId?: number;
  mode: "pointer" | "touch";
};

export function useExplicitDragScroll(rootRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }

    return setupExplicitDragScroll(root);
  }, [rootRef]);
}

export function setupExplicitDragScroll(root: HTMLElement): () => void {
  let drag: DragState | null = null;
  let lastTouchStartAt = 0;

  function beginDrag(target: EventTarget | null, clientY: number, mode: DragState["mode"], pointerId?: number) {
    if (!(target instanceof Element) || isEditableDragTarget(target)) {
      return;
    }
    const scrollTarget = findDragScrollTarget(target, root);
    if (!scrollTarget || !root.contains(scrollTarget)) {
      return;
    }
    drag = {
      scrollTarget,
      startY: clientY,
      lastY: clientY,
      dragging: false,
      suppressClick: false,
      pointerId,
      mode,
    };
  }

  function updateDrag(clientY: number, event: Event) {
    if (!drag) {
      return;
    }
    const totalDelta = clientY - drag.startY;
    const stepDelta = clientY - drag.lastY;
    if (!drag.dragging && Math.abs(totalDelta) < dragThresholdPx) {
      drag.lastY = clientY;
      return;
    }

    drag.dragging = true;
    drag.suppressClick = true;
    drag.scrollTarget.scrollTop -= stepDelta;
    drag.lastY = clientY;
    event.preventDefault();
  }

  function endDrag() {
    if (!drag) {
      return;
    }
    if (drag.suppressClick) {
      globalThis.setTimeout(() => {
        if (drag?.suppressClick) {
          drag = null;
        }
      }, 0);
      return;
    }
    drag = null;
  }

  function onPointerDown(event: PointerEvent) {
    if (event.pointerType === "mouse" || Date.now() - lastTouchStartAt < 700) {
      return;
    }
    beginDrag(event.target, event.clientY, "pointer", event.pointerId);
  }

  function onPointerMove(event: PointerEvent) {
    if (!drag || drag.mode !== "pointer" || drag.pointerId !== event.pointerId) {
      return;
    }
    updateDrag(event.clientY, event);
  }

  function onPointerEnd(event: PointerEvent) {
    if (!drag || drag.mode !== "pointer" || drag.pointerId !== event.pointerId) {
      return;
    }
    endDrag();
  }

  function onTouchStart(event: TouchEvent) {
    lastTouchStartAt = Date.now();
    const touch = event.touches[0];
    if (!touch) {
      return;
    }
    beginDrag(event.target, touch.clientY, "touch");
  }

  function onTouchMove(event: TouchEvent) {
    if (!drag || drag.mode !== "touch") {
      return;
    }
    const touch = event.touches[0];
    if (!touch) {
      return;
    }
    updateDrag(touch.clientY, event);
  }

  function onTouchEnd() {
    if (!drag || drag.mode !== "touch") {
      return;
    }
    endDrag();
  }

  function onClick(event: MouseEvent) {
    if (!drag?.suppressClick) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    drag = null;
  }

  root.addEventListener("pointerdown", onPointerDown, { passive: true });
  root.addEventListener("pointermove", onPointerMove, { passive: false });
  root.addEventListener("pointerup", onPointerEnd, { passive: true });
  root.addEventListener("pointercancel", onPointerEnd, { passive: true });
  root.addEventListener("touchstart", onTouchStart, { passive: true });
  root.addEventListener("touchmove", onTouchMove, { passive: false });
  root.addEventListener("touchend", onTouchEnd, { passive: true });
  root.addEventListener("touchcancel", onTouchEnd, { passive: true });
  root.addEventListener("click", onClick, true);

  return () => {
    root.removeEventListener("pointerdown", onPointerDown);
    root.removeEventListener("pointermove", onPointerMove);
    root.removeEventListener("pointerup", onPointerEnd);
    root.removeEventListener("pointercancel", onPointerEnd);
    root.removeEventListener("touchstart", onTouchStart);
    root.removeEventListener("touchmove", onTouchMove);
    root.removeEventListener("touchend", onTouchEnd);
    root.removeEventListener("touchcancel", onTouchEnd);
    root.removeEventListener("click", onClick, true);
  };
}

export function isEditableDragTarget(target: Element): boolean {
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']"));
}

function findDragScrollTarget(target: Element, root: HTMLElement): HTMLElement | null {
  let element: Element | null = target;
  let fallback: HTMLElement | null = null;

  while (element && root.contains(element)) {
    if (element instanceof HTMLElement && element.matches(dragScrollSelector)) {
      fallback ??= element;
      if (element.scrollHeight > element.clientHeight) {
        return element;
      }
    }
    if (element === root) {
      break;
    }
    element = element.parentElement;
  }

  return fallback;
}
