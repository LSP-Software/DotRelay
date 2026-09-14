"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

const scrollElementIntoDialog = (
  container: HTMLElement,
  target: HTMLElement,
) => {
  const containerBox = container.getBoundingClientRect();
  const targetBox = target.getBoundingClientRect();
  // A sticky footer covers the bottom of the scroll region, so the target
  // must clear it to stay visible; an on-screen keyboard can shrink the
  // visual viewport below the layout viewport, so it must also clear the
  // visible bottom. Fall back to the container bottom only when the target
  // is too tall to fit above those. The 2px margin absorbs integer
  // scrollTop rounding.
  let clearBottom = containerBox.bottom - 2;
  const footer = container.querySelector('[data-slot="dialog-footer"]');
  if (footer instanceof HTMLElement) {
    const footerBox = footer.getBoundingClientRect();
    if (footerBox.top > containerBox.top)
      clearBottom = Math.min(clearBottom, footerBox.top - 2);
  }
  const visualViewport = window.visualViewport;
  if (visualViewport) {
    const visibleBottom =
      visualViewport.offsetTop + visualViewport.height / visualViewport.scale;
    if (visibleBottom < window.innerHeight - 1)
      clearBottom = Math.min(clearBottom, visibleBottom - 2);
  }
  if (targetBox.top >= containerBox.top && targetBox.bottom <= clearBottom)
    return;
  if (targetBox.top < containerBox.top) {
    container.scrollTop += targetBox.top - containerBox.top;
  } else if (
    targetBox.bottom - targetBox.top <=
    clearBottom - containerBox.top
  ) {
    container.scrollTop += targetBox.bottom - clearBottom;
  } else container.scrollTop += targetBox.bottom - containerBox.bottom;
};

const scrollFocusedElementIntoDialog = (
  event: React.FocusEvent<HTMLElement>,
) => {
  const container = event.currentTarget;
  const target = event.target;
  if (target === container || !(target instanceof HTMLElement)) return;
  scrollElementIntoDialog(container, target);
};

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
}) {
  const popupRef = React.useRef<HTMLDivElement>(null);

  // A keyboard or zoom change can shrink the viewport after a field is
  // focused, and a dvh-constrained dialog then shrinks without any focus
  // event: re-run the scroll-into-view pass for the focused element on
  // layout and visual viewport resize. The popup node only exists while
  // the dialog is open, so resolve it at event time rather than at mount
  // (the component mounts with the dialog closed). The dvh constraint
  // settles over a short layout animation, so keep re-running the pass
  // for a few frames after each resize to land on the final geometry.
  React.useEffect(() => {
    const repositionFocusedElement = () => {
      const popup = popupRef.current;
      if (!popup) return;
      const target = popup.ownerDocument.activeElement;
      if (
        target instanceof HTMLElement &&
        target !== popup &&
        popup.contains(target)
      ) {
        scrollElementIntoDialog(popup, target);
      }
    };
    let settleFrames = 0;
    const settle = () => {
      if (settleFrames <= 0) return;
      settleFrames -= 1;
      repositionFocusedElement();
      requestAnimationFrame(settle);
    };
    const onResize = () => {
      settleFrames = 20;
      settle();
    };
    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener("resize", onResize);
    window.addEventListener("resize", onResize);
    return () => {
      visualViewport?.removeEventListener("resize", onResize);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        ref={popupRef}
        className={cn(
          "fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 space-y-4 overflow-y-auto overflow-x-hidden overscroll-contain rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        onFocusCapture={scrollFocusedElementIntoDialog}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-2 right-2"
                size="icon-sm"
              />
            }
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "sticky bottom-0 -mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end max-sm:[&>button]:h-auto max-sm:[&>button]:min-h-8 max-sm:[&>button]:min-w-0 max-sm:[&>button]:w-full max-sm:[&>button]:whitespace-normal",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-none font-medium",
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
