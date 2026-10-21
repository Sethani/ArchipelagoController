const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;

function parseUniversalTrackerOutput(raw) {
  const lines = String(raw ?? '').replace(ANSI, '').replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
  const markerIndex = lines.findIndex((line) => /Game: .*\| Slot Name : .*\| In logic locations : \d+/i.test(line));
  if (markerIndex < 0) {
    const failure = lines.findLast((line) => /generation failure|traceback|error:|valueerror|filenotfounderror/i.test(line));
    throw new Error(failure || 'Universal Tracker did not return logic results.');
  }
  const inLogic = Number(lines[markerIndex].match(/In logic locations : (\d+)/i)?.[1] ?? 0);
  const locations = lines.slice(markerIndex + 1).filter((line) => !/^(?:Connection closed|Disconnected|Shutting down|Aborted|Process finished)/i.test(line));
  return { inLogic, glitched: Math.max(0, locations.length - inLogic), available: locations.length, locations };
}

module.exports = { parseUniversalTrackerOutput };
