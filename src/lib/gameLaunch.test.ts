import { describe, expect, it } from 'vitest';
import { previewLaunchTemplate, suggestLaunchTemplate } from './gameLaunch';

describe('launch profile suggestions', () => {
  it('turns a pasted VVVVVV command into a reusable room command', () => {
    expect(suggestLaunchTemplate('-v6ap_name Sethiduck_V -v6ap_ip localhost:38281', 'Sethiduck_V', ''))
      .toBe('-v6ap_name {slot} -v6ap_ip {endpoint}');
  });

  it('previews dynamic values', () => {
    expect(previewLaunchTemplate('{slot} at {endpoint}', { slot: 'Sethiduck_V', endpoint: 'archipelago.gg:45678' }))
      .toBe('Sethiduck_V at archipelago.gg:45678');
  });
});
