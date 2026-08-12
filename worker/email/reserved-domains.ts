// ABOUTME: Recognizes recipient addresses whose domain is reserved and can never accept mail.
// ABOUTME: Greenroom refuses to hand these to a provider, because every such send is a hard bounce.
import type { EmailDelivery } from "../email.ts";

/**
 * Second-level domains RFC 2606 reserves for documentation and examples. Their
 * subdomains are reserved with them, so `speaker@mail.example.com` is as
 * undeliverable as `speaker@example.com`.
 */
const reservedDomains = ["example.com", "example.net", "example.org"];

/**
 * Top-level domains RFC 2606 and RFC 6761 reserve for testing, invalid names,
 * documentation, and loopback. Nothing under them resolves to a real mail host.
 */
const reservedTopLevelDomains = ["invalid", "test", "example", "localhost"];

/**
 * The domain part of an address, lowercased with any trailing root dot removed.
 * Returns null when there is nothing that looks like a domain to judge.
 */
function domainOf(recipient: string): string | null {
  const at = recipient.lastIndexOf("@");
  if (at === -1) {
    return null;
  }
  const domain = recipient.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
  return domain === "" ? null : domain;
}

function isOrIsUnder(domain: string, reserved: string): boolean {
  return domain === reserved || domain.endsWith(`.${reserved}`);
}

/**
 * True when mail to this address cannot possibly arrive, because its domain is
 * reserved by the RFCs rather than registrable. Matching is by whole label, so a
 * legitimately registered lookalike such as `myexample.com` or `testing.com` is
 * left alone.
 */
export function isUndeliverableRecipient(recipient: string): boolean {
  const domain = domainOf(recipient);
  if (domain === null) {
    return false;
  }
  if (reservedDomains.some((reserved) => isOrIsUnder(domain, reserved))) {
    return true;
  }
  const topLevelDomain = domain.slice(domain.lastIndexOf(".") + 1);
  return reservedTopLevelDomains.includes(topLevelDomain);
}

/**
 * The reason recorded against a refused send and shown to the organizer who
 * tried it. It names the address so a partly-refused batch stays readable, and
 * says plainly that nothing was sent.
 */
export function undeliverableRecipientReason(recipient: string): string {
  return `${recipient} is at a reserved domain that can never receive mail, so nothing was sent.`;
}

/**
 * Wraps a delivery that really reaches a provider so a reserved recipient is
 * refused before the network call. The refusal is an ordinary `failed` result,
 * so it travels back through `sendTrackedEmail` onto the same dispatch and
 * decision-notice rows every other rejection uses: an organizer sees the send
 * failed and why, and nothing is ever recorded as sent.
 *
 * This sits around the resolved sender rather than inside `sendTrackedEmail` so
 * that an environment with no sender configured keeps reporting exactly what it
 * reported before - `provider_not_configured`, writing nothing and leaving a
 * queued letter queued.
 */
export function refuseUndeliverableRecipients(delivery: EmailDelivery): EmailDelivery {
  return {
    async send(message) {
      if (isUndeliverableRecipient(message.recipient)) {
        return { status: "failed", error: undeliverableRecipientReason(message.recipient) };
      }
      return delivery.send(message);
    },
  };
}
