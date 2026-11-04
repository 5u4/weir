import { type Event, facePath } from "@weir/daemon/Api";
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";

const faceVersion = Atom.family((_: string) => Atom.make(0).pipe(Atom.keepAlive));

const faceRound = Atom.make(0).pipe(Atom.keepAlive);

export const faceSrc = Atom.family((path: string) =>
  Atom.make((get) => {
    const version = get(faceVersion(path));
    const round = get(faceRound);
    return version === 0 && round === 0 ? path : `${path}&v=${round}.${version}`;
  }),
);

export const observeFaces = (registry: AtomRegistry.AtomRegistry, event: Event) => {
  switch (event.type) {
    case "faces":
      for (const address of event.addresses) {
        for (const verified of [false, true]) {
          const path = facePath(event.source, address, verified);
          if (path !== null) registry.update(faceVersion(path), (version) => version + 1);
        }
      }
      return;
    case "ready":
      registry.update(faceRound, (round) => round + 1);
      return;
    case "reload":
      if (event.status === "ok") {
        registry.update(faceRound, (round) => round + 1);
      }
      return;
  }
};
