const DEFAULT_PORT_SCAN_COUNT = 20;

interface EndpointCandidateOptions {
  scheme: "http" | "https" | "ws" | "wss";
  defaultPort: number;
  fallbackPath?: string;
  scanCount?: number;
}

function normalizeEndpoint(url: URL) {
  return url.toString().replace(/\/$/, "");
}

function portsFrom(startPort: number, count: number) {
  return Array.from({ length: count }, (_, index) => startPort + index).filter(
    (port) => port <= 65_535,
  );
}

/**
 * Construye las direcciones que puede probar la app cuando el puerto preferido
 * ya estaba ocupado. Una URL configurada conserva su host y ruta; en Expo Go
 * también se puede deducir el host desde la dirección de Metro.
 */
export function buildEndpointCandidates(
  configuredUrl: string | undefined,
  expoHostUri: string | null | undefined,
  options: EndpointCandidateOptions,
) {
  const scanCount = Math.max(
    1,
    Math.min(options.scanCount ?? DEFAULT_PORT_SCAN_COUNT, 100),
  );
  const configured = configuredUrl?.trim();

  if (configured) {
    try {
      const parsed = new URL(configured);
      if (!parsed.port) return [normalizeEndpoint(parsed)];

      const firstPort = Number(parsed.port);
      if (!Number.isInteger(firstPort) || firstPort < 1) return [configured];

      return portsFrom(firstPort, scanCount).map((port) => {
        const candidate = new URL(parsed.toString());
        candidate.port = String(port);
        return normalizeEndpoint(candidate);
      });
    } catch {
      return [configured];
    }
  }

  if (!expoHostUri) return [];

  try {
    const metroUrl = new URL(
      expoHostUri.includes("://") ? expoHostUri : `http://${expoHostUri}`,
    );
    const path = options.fallbackPath?.startsWith("/")
      ? options.fallbackPath
      : options.fallbackPath
        ? `/${options.fallbackPath}`
        : "";

    return portsFrom(options.defaultPort, scanCount).map(
      (port) => `${options.scheme}://${metroUrl.hostname}:${port}${path}`,
    );
  } catch {
    return [];
  }
}

