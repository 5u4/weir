import type { CSSProperties } from "react";
import { hue, monogram, type Sender } from "./Notch.ts";

export function Avatar({ address, mark }: { address: string; mark: string }) {
  return (
    <span
      className="av"
      aria-hidden="true"
      data-m={mark}
      style={{ "--h": hue(address) } as CSSProperties}
    />
  );
}

export function Avatars({ senders }: { senders: ReadonlyArray<Sender> }) {
  if (senders.length === 0) return null;
  return (
    <span className="avs" aria-hidden="true">
      {senders.slice(0, 3).map((sender) => (
        <Avatar key={sender.address} address={sender.address} mark={monogram(sender)} />
      ))}
    </span>
  );
}
