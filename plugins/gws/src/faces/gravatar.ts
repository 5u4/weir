import { createHash } from "node:crypto";
import { Face, FaceMime, maxFaceBytes } from "@weir/contract/Source";
import * as Schema from "effect/Schema";
import { type FaceNet, readCapped } from "./net.ts";

const isFaceMime = Schema.is(FaceMime);
const isFace = Schema.is(Face);

export const gravatar = async (
  net: FaceNet,
  address: string,
  signal: AbortSignal,
): Promise<Face> => {
  const hash = createHash("sha256").update(address).digest("hex");
  const response = await net.fetch(`https://gravatar.com/avatar/${hash}?d=404&s=96`, signal);
  const mime = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (response.status !== 200 || !isFaceMime(mime)) {
    await response.body?.cancel();
    if (response.status === 404) return { status: "missing" };
    return {
      status: "failed",
      error:
        response.status === 200
          ? `gravatar sent ${mime || "no content type"}`
          : `gravatar answered ${response.status}`,
    };
  }
  const bytes = await readCapped(response, maxFaceBytes);
  if (bytes === null) {
    return { status: "failed", error: `gravatar image is over ${maxFaceBytes} bytes` };
  }
  const face: Face = { status: "found", kind: "portrait", mime, bytes };
  return isFace(face) ? face : { status: "failed", error: `gravatar bytes are not ${mime}` };
};
