/**
 * Hosted call flows (HTTP mode): XML documents this server serves to Vobiz at
 *   /xml/flow/<id>     answer / transfer target
 *   /xml/gather/<id>   Gather action callback: records the digits, then returns the flow's follow-up XML
 * Flow IDs are 128-bit random values, so a URL is only usable by whoever was given it.
 */
import { randomBytes } from "node:crypto";
import { escapeXml } from "./xml.js";

export interface GatherResult {
  digits: string;
  input_type: string | null;
  speech: string | null;
  call_uuid: string | null;
  received_at: string;
  signature_verified: boolean;
}

interface Flow {
  xml: string;
  kind: string;
  createdAt: number;
  afterXml?: string;
  results: GatherResult[];
}

export type FlowSpec =
  | { kind: "xml"; xml: string; afterXml?: string }
  | { kind: "dial"; destination: string; callerId?: string; timeLimit: number }
  | { kind: "hold"; musicUrl?: string };

const MAX_FLOWS = 2000;
const DEFAULT_AFTER_GATHER = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Speak>Thank you.</Speak>
    <Hangup/>
</Response>
`;

export class FlowStore {
  private flows = new Map<string, Flow>();

  constructor(
    readonly publicUrl: string,
    private readonly ttlMs = 24 * 3600_000,
    private readonly now: () => number = Date.now,
  ) {}

  newId(): string {
    return randomBytes(16).toString("hex");
  }

  /** URL Vobiz should POST Gather input to for flow `id`. */
  gatherUrl(id: string): string {
    return `${this.publicUrl}/xml/gather/${id}`;
  }

  flowUrl(id: string): string {
    return `${this.publicUrl}/xml/flow/${id}`;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, f] of this.flows) if (t - f.createdAt > this.ttlMs) this.flows.delete(k);
    while (this.flows.size >= MAX_FLOWS) this.flows.delete(this.flows.keys().next().value as string);
  }

  create(spec: FlowSpec, id = this.newId()): string {
    this.prune();
    let xml: string;
    if (spec.kind === "xml") xml = spec.xml;
    else if (spec.kind === "dial") {
      const target = spec.destination.startsWith("sip:")
        ? `<User>${escapeXml(spec.destination)}</User>`
        : `<Number>${escapeXml(spec.destination.startsWith("+") ? spec.destination : "+" + spec.destination)}</Number>`;
      const callerId = spec.callerId ? ` callerId="${escapeXml(spec.callerId)}"` : "";
      xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n    <Dial${callerId} timeLimit="${spec.timeLimit}">\n        ${target}\n    </Dial>\n</Response>\n`;
    } else {
      xml = spec.musicUrl
        ? `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n    <Play loop="0">${escapeXml(spec.musicUrl)}</Play>\n</Response>\n`
        : `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n    <Wait length="3600" silence="true"/>\n</Response>\n`;
    }
    this.flows.set(id, { xml, kind: spec.kind, createdAt: this.now(), afterXml: spec.kind === "xml" ? spec.afterXml : undefined, results: [] });
    return id;
  }

  getXml(id: string): string | undefined {
    return this.flows.get(id)?.xml;
  }

  /** Records Gather input and returns the XML to continue with. */
  recordGather(id: string, r: GatherResult): string | undefined {
    const f = this.flows.get(id);
    if (!f) return undefined;
    if (f.results.length < 50) f.results.push(r);
    return f.afterXml ?? DEFAULT_AFTER_GATHER;
  }

  /** Same Gather callback delivered again (Vobiz retry): do not record twice, just continue the flow. */
  recordGatherReplay(id: string): string | undefined {
    const f = this.flows.get(id);
    if (!f) return undefined;
    return f.afterXml ?? DEFAULT_AFTER_GATHER;
  }

  results(id: string): { exists: boolean; kind?: string; results: GatherResult[] } {
    const f = this.flows.get(id);
    return f ? { exists: true, kind: f.kind, results: [...f.results] } : { exists: false, results: [] };
  }
}
