/**
 * Address admission for the public fetcher.
 *
 * The rule is deny-by-default: an address is usable only when a maintained IP
 * parser classifies it as ordinary unicast. Everything else — loopback,
 * private, link-local (cloud metadata), carrier-grade NAT, multicast,
 * unspecified, broadcast, documentation/benchmarking/reserved ranges, IPv6
 * unique-local, and IPv4-mapped IPv6 — is refused. The mapped form is unwrapped
 * and re-checked so `::ffff:127.0.0.1` cannot slip through as IPv6.
 */
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

export interface PublicAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export class WebAddressError extends Error {
  readonly code = "address";

  constructor(message: string) {
    super(message);
    this.name = "WebAddressError";
  }
}

/** URL.hostname keeps brackets around IPv6 literals; the socket layer wants them off. */
export function normalizeHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** The literal address of a URL host, or undefined when the host needs DNS. */
export function ipLiteral(hostname: string): string | undefined {
  const host = normalizeHostname(hostname);
  return isIP(host) === 0 ? undefined : host;
}

/**
 * Throw unless `value` is a single ordinary public unicast address. Returns the
 * normalized address and family for the pinned socket connection.
 */
export function assertPublicAddress(value: string): PublicAddress {
  if (value.includes("%")) throw new WebAddressError("The address is not a public internet address");
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(value);
  } catch {
    throw new WebAddressError("The host did not resolve to an IP address");
  }
  if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
    // A mapped IPv4 address is classified as IPv6; judge the IPv4 it carries.
    return mappedOrPublic(parsed.toIPv4Address());
  }
  if (parsed.range() !== "unicast") {
    throw new WebAddressError("The host resolves to a non-public address, which this tool refuses");
  }
  return { address: parsed.toNormalizedString(), family: parsed.kind() === "ipv4" ? 4 : 6 };
}

function mappedOrPublic(address: ipaddr.IPv4 | ipaddr.IPv6): PublicAddress {
  if (address.range() !== "unicast") {
    throw new WebAddressError("The host resolves to a non-public address, which this tool refuses");
  }
  return {
    address: address.toNormalizedString(),
    family: address.kind() === "ipv4" ? 4 : 6,
  };
}
