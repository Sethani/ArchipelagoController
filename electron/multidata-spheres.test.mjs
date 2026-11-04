import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import spheresModule from './multidata-spheres.cjs';

const { archiveMultidata, checkedSphereSnapshot, completeSphereSnapshot, decodePickle } = spheresModule;

function pickle(value, root = true) {
  const chunks = root ? [Buffer.from([0x80, 0x02])] : [];
  const emit = (next) => chunks.push(Buffer.isBuffer(next) ? next : Buffer.from(next));
  if (value === null) emit([0x4e]);
  else if (value === true) emit([0x88]);
  else if (value === false) emit([0x89]);
  else if (Number.isInteger(value)) { const bytes = Buffer.alloc(5); bytes[0] = 0x4a; bytes.writeInt32LE(value, 1); emit(bytes); }
  else if (typeof value === 'string') { const bytes = Buffer.from(value); const header = Buffer.alloc(5); header[0] = 0x58; header.writeUInt32LE(bytes.length, 1); emit(header); emit(bytes); }
  else if (value instanceof Set) { emit('cbuiltins\nset\n'); emit(pickle([...value], false)); emit([0x85, 0x52]); }
  else if (Array.isArray(value)) { emit([0x5d]); for (const item of value) { emit(pickle(item, false)); emit([0x61]); } }
  else if (value && typeof value === 'object') { emit([0x7d]); for (const [key, item] of Object.entries(value)) { emit(pickle(key, false)); emit(pickle(item, false)); emit([0x73]); } }
  else throw new Error('Unsupported test value');
  if (root) emit([0x2e]);
  return Buffer.concat(chunks);
}

describe('safe multidata sphere decoding', () => {
  it('intersects static spheres with live checked locations and resolves item links', () => {
    const multidata = {
      spheres: [{ 1: new Set([100, 101]) }],
      locations: { 1: { 100: [200, 2, 1], 101: [201, 1, 1] } },
      slot_info: { 1: { args: ['Finder slot', 'Finder'] }, 2: { args: ['Receiver slot', 'Receiver'] } },
      datapackage: {
        Finder: { location_name_to_id: { 'First check': 100, 'Future check': 101 }, item_name_to_id: {} },
        Receiver: { location_name_to_id: {}, item_name_to_id: { 'Linked item': 200 } },
      },
    };
    const container = Buffer.concat([Buffer.from([3]), deflateSync(pickle(multidata))]);
    const decoded = archiveMultidata(container);
    const snapshot = checkedSphereSnapshot(decoded.value, { players: [
      { slot: 1, name: 'Finder slot', game: 'Finder', checkedLocationIds: [100] },
      { slot: 2, name: 'Receiver slot', game: 'Receiver', checkedLocationIds: [] },
    ] });
    expect(snapshot.available).toBe(true);
    expect(snapshot.checks).toEqual([expect.objectContaining({ sphere: 1, location: 'First check', item: 'Linked item', finderSlot: 1, receiverSlot: 2 })]);
    expect(completeSphereSnapshot(decoded.value).checks).toEqual([
      expect.objectContaining({ location: 'First check' }),
      expect.objectContaining({ location: 'Future check' }),
    ]);
  });

  it('rejects unknown globals without invoking them', () => {
    expect(() => decodePickle(Buffer.concat([Buffer.from([0x80, 0x02]), Buffer.from('cos\nsystem\n.')]))).toThrow(/Unsupported pickle global/);
  });

  it('reports unsupported container versions', () => {
    expect(() => archiveMultidata(Buffer.from([9, 1, 2, 3]))).toThrow(/container version/);
  });
});
