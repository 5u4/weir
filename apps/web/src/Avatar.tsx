import { useAtomValue } from "@effect/atom-react";
import { facePath } from "@weir/daemon/Api";
import type { CSSProperties } from "react";
import { faceSrc } from "./Faces.ts";
import { hue, monogram, type Sender } from "./Notch.ts";

const faceClass =
  "absolute inset-0 size-full rounded-circle bg-avatar object-cover opacity-none transition-opacity duration-base ease-standard motion-reduce:transition-none data-loaded:opacity-full";

const faceLoad = (img: HTMLImageElement) => {
  const loaded = () => img.setAttribute("data-loaded", "");
  const failed = () => img.removeAttribute("data-loaded");
  if (img.complete && img.naturalWidth > 0) loaded();
  img.addEventListener("load", loaded);
  img.addEventListener("error", failed);
  return () => {
    img.removeEventListener("load", loaded);
    img.removeEventListener("error", failed);
  };
};

function Face({ path }: { path: string }) {
  return (
    <img
      src={useAtomValue(faceSrc(path))}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      ref={faceLoad}
      className={faceClass}
    />
  );
}

export function Avatar({
  source,
  address,
  verified,
  mark,
  className = "",
}: {
  source: string;
  address: string;
  verified: boolean;
  mark: string;
  className?: string;
}) {
  const path = facePath(source, address, verified);
  return (
    <span
      className={`relative inline-grid size-em-1 flex-none place-items-center overflow-hidden rounded-circle bg-avatar text-avatar-ink before:content-data-m before:font-sans before:text-av-initial before:leading-none before:font-bold before:tracking-normal ${className}`}
      aria-hidden="true"
      data-m={mark}
      style={{ "--h": hue(address) } as CSSProperties}
    >
      {path !== null && <Face key={path} path={path} />}
    </span>
  );
}

const stackClass = "-top-em-0.05 mr-em-0.25";

export function Avatars({
  senders,
  className = stackClass,
  on = false,
}: {
  senders: ReadonlyArray<Sender>;
  className?: string;
  on?: boolean;
}) {
  if (senders.length === 0) return null;
  return (
    <span
      className={`relative inline-flex align-middle ${className}`}
      aria-hidden="true"
      data-stack=""
    >
      {senders.slice(0, 3).map((sender, index) => (
        <Avatar
          key={`${sender.source}\u0000${sender.address}`}
          source={sender.source}
          address={sender.address}
          verified={sender.verified}
          mark={monogram(sender)}
          className={`text-em-sm ${on ? "shadow-stack-cap-1" : "shadow-stack-capbg"} ${index > 0 ? "-ml-em-0.3" : ""}`}
        />
      ))}
    </span>
  );
}
