import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { compiledComponents, componentsFromEntries, resolveLauncherClient, sourceComponents } = require('./launcher-components.cjs');

describe('launcher component discovery', () => {
  it('reads component display names and types from APWorld source', () => {
    const source = `
      from LauncherComponents import Component, Type, components
      components.append(Component(
        "Stardew Valley Tracker",
        component_type=Type.CLIENT,
        supports_uri=True,
        game_name="Stardew Valley",
        func=launch_tracker,
      ))
    `;

    expect(sourceComponents(source)).toEqual([{ displayName: 'Stardew Valley Tracker', type: 'client', supportsUri: true, gameNames: ['Stardew Valley'] }]);
  });

  it('finds title-like labels in compiled worlds without exposing enum constants or prose', () => {
    const contents = Buffer.from([
      'LauncherComponents', 'Component', 'components', 'CLIENT',
      'Stardew Valley Tracker)', 'Launch the tracker client',
    ].join('\0'), 'latin1');

    expect(compiledComponents(contents)).toEqual([{ displayName: 'Stardew Valley Tracker', type: 'unknown', supportsUri: false, gameNames: [] }]);
  });

  it('labels components with the game and package origin', () => {
    const entries = {
      'sample/archipelago.json': Buffer.from(JSON.stringify({ game: 'Sample Game' })),
      'sample/__init__.py': Buffer.from('components.append(Component("Sample Game Client", component_type=Type.CLIENT))'),
    };

    expect(componentsFromEntries(entries, 'sample', 'custom')).toEqual([{
      displayName: 'Sample Game Client', type: 'client', supportsUri: false, gameNames: [], sourceWorld: 'Sample Game', origin: 'custom',
    }]);
  });
});

describe('launcher client resolution', () => {
  it('routes a manifest game through the URI game name registered by its client', () => {
    expect(resolveLauncherClient([{ displayName: 'Portal 2 Client', type: 'client', supportsUri: true, sourceWorld: 'Portal 2', gameNames: ['Portal2'] }], 'Portal 2'))
      .toEqual({ displayName: 'Portal 2 Client', supportsUri: true, mode: 'uri', gameName: 'Portal2' });
  });
});
