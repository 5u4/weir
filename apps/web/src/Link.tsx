import { useAtom } from "@effect/atom-react/Hooks";
import type { MouseEvent, ReactNode } from "react";
import { href, type Route, route } from "./Route.ts";

const plainLeftClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

export function Link({
  to,
  current,
  pop = false,
  className,
  description,
  children,
}: {
  to: Route;
  current: boolean;
  pop?: boolean;
  className: string;
  description?: string | undefined;
  children: ReactNode;
}) {
  const [, navigate] = useAtom(route);
  return (
    <a
      className={`${className}${current ? " on" : ""}`}
      href={href(to)}
      aria-current={current ? "page" : undefined}
      data-pop={pop || undefined}
      aria-description={description}
      title={description}
      onClick={(event) => {
        if (event.defaultPrevented || !plainLeftClick(event)) return;
        event.preventDefault();
        navigate({ _tag: "Go", to });
      }}
    >
      {children}
    </a>
  );
}
