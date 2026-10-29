import type { CSSProperties } from "react";
import { hue, monogram, type Sender } from "./Notch.ts";

export function Avatar({ sender }: { sender: Sender | null }) {
  if (sender === null) return <span className="av blank" aria-hidden="true" />;
  return (
    <span
      className="av"
      aria-hidden="true"
      data-m={monogram(sender)}
      style={{ "--h": hue(sender.address) } as CSSProperties}
    />
  );
}

export function Avatars({ senders }: { senders: ReadonlyArray<Sender> }) {
  if (senders.length === 0) return null;
  return (
    <span className="avs" aria-hidden="true">
      {senders.slice(0, 3).map((sender) => (
        <Avatar key={sender.address} sender={sender} />
      ))}
    </span>
  );
}
