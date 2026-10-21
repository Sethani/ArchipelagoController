import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { roomPage } = require('./room-page.cjs');

describe('hosted room page', () => {
  it('contains the progress, hint, activity, and download views with valid client script', () => {
    const html = roomPage('room_test_123');
    expect(html).toContain('Multiworld progress');
    expect(html).toContain('Hinted items');
    expect(html).toContain('Recent room activity');
    expect(html).toContain('Slot downloads');
    expect(html).toContain('Room total');
    expect(html).toContain('sortState');
    expect(html).toContain('@media(max-width:620px)');
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script)).not.toThrow();
  });

  it('serializes the room id as data rather than executable markup', () => {
    const html = roomPage('</script><script>alert(1)</script>');
    expect(html).not.toContain('const id="</script>');
  });
});
