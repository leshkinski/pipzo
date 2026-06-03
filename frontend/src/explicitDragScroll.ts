import { useEffect, type RefObject } from "react";

const dragScrollSelector = "[data-drag-scroll]";
const dragThresholdPx = 8;

type DragState = {
  scrollTarget: HTMLElement;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  dragging: boolean;
  suppressClick: boolean;
  pointerId?: number;
  mode: "pointer" | "touch";
  axis: "x" | "y" | null;
  captured: boolean;
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

  function beginDrag(target: EventTarget | null, clientX: number, clientY: number, mode: DragState["mode"], pointerId?: number) {
    if (!(target instanceof Element) || isEditableDragTarget(target)) {
      return;
    }
    const scrollTarget = findDragScrollTarget(target, root);
    if (!scrollTarget || !root.contains(scrollTarget)) {
      return;
    }
    drag = {
      scrollTarget,
      startX: clientX,
      startY: clientY,
      lastX: clientX,
      lastY: clientY,
      dragging: false,
      suppressClick: false,
      pointerId,
      mode,
      axis: null,
      captured: false,
    };
  }

  function updateDrag(clientX: number, clientY: number, event: Event) {
    if (!drag) {
      return;
    }
    const totalDeltaX = clientX - drag.startX;
    const totalDelta = clientY - drag.startY;
    const stepDeltaX = clientX - drag.lastX;
    const stepDelta = clientY - drag.lastY;
    if (!drag.dragging && Math.max(Math.abs(totalDeltaX), Math.abs(totalDelta)) < dragThresholdPx) {
      drag.lastX = clientX;
      drag.lastY = clientY;
      return;
    }

    if (!drag.axis) {
      const canScrollX = drag.scrollTarget.scrollWidth > drag.scrollTarget.clientWidth;
      const canScrollY = drag.scrollTarget.scrollHeight > drag.scrollTarget.clientHeight;
      drag.axis = canScrollX && (!canScrollY || Math.abs(totalDeltaX) > Math.abs(totalDelta)) ? "x" : "y";
    }
    if (drag.mode === "pointer" && !drag.captured && drag.pointerId !== undefined) {
      try {
        root.setPointerCapture(drag.pointerId);
        drag.captured = true;
      } catch {
        drag.captured = true;
      }
    }

    drag.dragging = true;
    drag.suppressClick = true;
    if (drag.axis === "x") {
      drag.scrollTarget.scrollLeft -= stepDeltaX;
    } else {
      drag.scrollTarget.scrollTop -= stepDelta;
    }
    drag.lastX = clientX;
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
    if (event.pointerType !== "mouse" && Date.now() - lastTouchStartAt < 700) {
      return;
    }
    beginDrag(event.target, event.clientX, event.clientY, "pointer", event.pointerId);
  }

  function onPointerMove(event: PointerEvent) {
    if (!drag || drag.mode !== "pointer" || drag.pointerId !== event.pointerId) {
      return;
    }
    updateDrag(event.clientX, event.clientY, event);
  }

  function onPointerEnd(event: PointerEvent) {
    if (!drag || drag.mode !== "pointer" || drag.pointerId !== event.pointerId) {
      return;
    }
    if (drag.captured) {
      try {
        root.releasePointerCapture(event.pointerId);
      } catch {
        // Ignore missing capture on browsers that ended the pointer independently.
      }
    }
    endDrag();
  }

  function onTouchStart(event: TouchEvent) {
    lastTouchStartAt = Date.now();
    const touch = event.touches[0];
    if (!touch) {
      return;
    }
    beginDrag(event.target, touch.clientX, touch.clientY, "touch");
  }

  function onTouchMove(event: TouchEvent) {
    if (!drag || drag.mode !== "touch") {
      return;
    }
    const touch = event.touches[0];
    if (!touch) {
      return;
    }
    updateDrag(touch.clientX, touch.clientY, event);
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

  function onDragStart(event: DragEvent) {
    if (event.target instanceof HTMLImageElement) {
      event.preventDefault();
    }
  }

  root.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
  root.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
  root.addEventListener("pointerup", onPointerEnd, { capture: true, passive: true });
  root.addEventListener("pointercancel", onPointerEnd, { capture: true, passive: true });
  root.addEventListener("touchstart", onTouchStart, { passive: true });
  root.addEventListener("touchmove", onTouchMove, { passive: false });
  root.addEventListener("touchend", onTouchEnd, { passive: true });
  root.addEventListener("touchcancel", onTouchEnd, { passive: true });
  root.addEventListener("click", onClick, true);
  root.addEventListener("dragstart", onDragStart, true);

  return () => {
    root.removeEventListener("pointerdown", onPointerDown, true);
    root.removeEventListener("pointermove", onPointerMove, true);
    root.removeEventListener("pointerup", onPointerEnd, true);
    root.removeEventListener("pointercancel", onPointerEnd, true);
    root.removeEventListener("touchstart", onTouchStart);
    root.removeEventListener("touchmove", onTouchMove);
    root.removeEventListener("touchend", onTouchEnd);
    root.removeEventListener("touchcancel", onTouchEnd);
    root.removeEventListener("click", onClick, true);
    root.removeEventListener("dragstart", onDragStart, true);
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
      if (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) {
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
