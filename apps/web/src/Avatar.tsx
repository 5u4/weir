import type { CSSProperties } from "react";
import { hue, monogram, type Sender } from "./Notch.ts";

export function Avatar({
  address,
  mark,
  className = "",
}: {
  address: string;
  mark: string;
  className?: string;
}) {
  return (
    <span
      className={`relative inline-grid size-em-1 flex-none place-items-center overflow-hidden rounded-circle bg-avatar text-avatar-ink before:content-data-m before:font-sans before:text-av-initial before:leading-none before:font-bold before:tracking-normal ${className}`}
      aria-hidden="true"
      data-m={mark}
      style={{ "--h": hue(address) } as CSSProperties}
    />
  );
}

export function Avatars({ senders }: { senders: ReadonlyArray<Sender> }) {
  if (senders.length === 0) return null;
  return (
    <span
      className="relative -top-em-0.05 mr-em-0.25 inline-flex align-middle"
      aria-hidden="true"
      data-stack=""
    >
      {senders.slice(0, 3).map((sender, index) => (
        <Avatar
          key={sender.address}
          address={sender.address}
          mark={monogram(sender)}
          className={`text-em-sm shadow-stack-capbg ${index > 0 ? "-ml-em-0.3" : ""}`}
        />
      ))}
    </span>
  );
}
