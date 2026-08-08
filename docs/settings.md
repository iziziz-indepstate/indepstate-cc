# Settings Extension Points

Service manifests register settings sections with `app/services/settings`:

```js
settings.register(
  'my-section',
  path.join(__dirname, 'config', 'my-section.json'),
  path.join(__dirname, 'config', 'my-section-settings-descriptor.json'),
  { livePaths: ['enabled'], restartPaths: ['provider'] }
);
```

The optional fourth argument declares how saved config changes are applied:

- `livePaths` lists paths that can be applied without restart.
- `restartPaths` lists paths that require restart.
- `'*'` means every changed path in that section.
- Unknown changed paths default to restart-required.

Modules should pass their own policy during `settings.register()` instead of adding module-specific
keys to the central `APPLY_POLICIES` map. Keep `APPLY_POLICIES` for legacy/core sections only.

## Defaults and Descriptor Fragments

Shared settings sections can accept module-provided defaults and descriptor fields:

```js
settings.registerDefaultsFragment('execution', {
  providers: {
    'my-provider': { adapter: 'my-adapter' }
  }
});

settings.registerDescriptorFragment('execution', {
  options: {
    providers: {
      'my-provider': {
        description: 'My provider settings',
        adapter: { type: 'string', description: 'Adapter name' }
      }
    }
  }
});
```

Fragments fill only missing values. Existing default config, runtime config, and user overrides keep
priority. Descriptor fragments let the Settings UI render module-owned fields without hard-coding
those fields into a shared service descriptor.
