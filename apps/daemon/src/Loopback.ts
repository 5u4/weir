const loopbackAuthority = /^(?:127\.0\.0\.1|localhost)(?::([1-9]\d*))?$/i;

const isLoopbackAuthority = (authority: string, port: number) => {
  const match = loopbackAuthority.exec(authority);
  return match !== null && Number(match[1] ?? 80) === port;
};

export const isLoopbackRequest = (
  host: string | undefined,
  origin: string | undefined,
  port: number,
) =>
  host !== undefined &&
  isLoopbackAuthority(host, port) &&
  (origin === undefined ||
    (origin.startsWith("http://") && isLoopbackAuthority(origin.slice("http://".length), port)));
