export interface ExternalEffect {
  kind: "network_write" | "external_message" | "external_state";
  replayable?: boolean;
}

export function observedExternalEffects(toolNames: readonly string[]): ExternalEffect[] {
  const effects = new Set<ExternalEffect["kind"]>();
  for (const name of toolNames) {
    const tool = name.toLowerCase().replaceAll("-", "_");
    if (/(?:^|[_:.])(?:send|post|publish)_(?:message|mail|email|notification)$/.test(tool)) effects.add("external_message");
    else if (/(?:^|[_:.])(?:http_(?:post|put|patch|delete)|network_write|upload_file|create_event)$/.test(tool)) effects.add("network_write");
    else if (/^(?:mcp[_:.]|connector[_:.])/.test(tool)) effects.add("external_state");
  }
  return [...effects].map(kind => ({ kind }));
}

export function dryRunDisposition(effects: readonly ExternalEffect[] = []): { useMock: boolean; degradedReason?: string } {
  const unavailable = effects.find(effect => effect.kind === "external_state" ? effect.replayable !== true : effect.replayable === false);
  if (unavailable) return { useMock: false, degradedReason: `Cannot replay external effect: ${unavailable.kind}` };
  return { useMock: effects.some(effect => effect.kind === "network_write" || effect.kind === "external_message") };
}
