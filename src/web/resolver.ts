/**
 * DNS admission for the public fetcher. Resolution and validation are one step:
 * every returned address must be ordinary public unicast, and the caller
 * connects to the validated address rather than looking the name up again.
 */
import { lookup } from "node:dns/promises";
import { WebAddressError, assertPublicAddress, type PublicAddress } from "./address.js";

export type WebResolver = (hostname: string) => Promise<readonly PublicAddress[]>;

export const nativeWebResolver: WebResolver = async (hostname) => {
  let answers: { address: string; family: number }[];
  try {
    answers = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new WebAddressError("The host could not be resolved");
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new WebAddressError("The host did not resolve to an IP address");
  }
  // Refuse the whole name if any answer is non-public: a mixed answer set must
  // never be "fixed" by connecting only to the convenient half.
  return answers.map((answer) => assertPublicAddress(answer.address));
};
