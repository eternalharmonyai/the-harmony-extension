# Harmony Creative Tools

Optional VS Code companion for the shared local Harmony Creative service.

This extension does not include or duplicate the Creative service. It discovers the shared `harmony-creative` service, starts it when needed, registers the Harmony Creative MCP provider with VS Code, exposes a separate Creative model-default selector, checks health, and opens the service or generated-media folders.

After reload, check the Explorer side bar for the `Harmony Creative` view. It contains the MCP server entry, Creative defaults, REST health, and generated-media folder actions. The same commands are also available from Command Palette.

## Commands

- `Harmony Creative: Start MCP Server`
- `Harmony Creative: Show Health`
- `Harmony Creative: Start Shared REST Service`
- `Harmony Creative: Select Model Defaults`
- `Harmony Creative: Select Image Quality`
- `Harmony Creative: Select Layer Backend`
- `Harmony Creative: Select Video Model`
- `Harmony Creative: Open Service Folder`
- `Harmony Creative: Open Generated Media`
- `Harmony Creative: Open Health Endpoint`
- `Harmony Creative: Show Companion Status`

The Creative selector is intentionally separate from the main VS Code/Copilot/Harmony chat model dropdown. It controls Creative generation defaults only: image quality, layer backend, and video model.

## Service Discovery

The companion checks paths in this order:

1. `harmonyCreative.servicePath`
2. `HARMONY_CREATIVE_SERVICE_PATH` or `HARMONY_CREATIVE_ROOT`
3. Current workspace folders
4. `harmonyCreative.centralHubPath`
5. `HARMONY_CENTRAL_HUB` or legacy central-workspace environment aliases
6. `~/Documents/HarmonyCentral/mcp-servers/harmony-creative`

For each root, it accepts any of these layouts:

- `<root>/rest_api.py`
- `<root>/harmony-creative/rest_api.py`
- `<root>/mcp-servers/harmony-creative/rest_api.py`

## Package And Reinstall

From this folder:

```powershell
npm install
npm run package
npm run install:vsix
```

From the main HarmonyExtension folder:

```powershell
npm run package:creative-tools
npm run install:creative-tools
```

Use `npm run install:creative-tools:both` from the main HarmonyExtension folder when both VS Code and Cursor should receive the companion.

For manual install, select `harmony-creative-tools-0.1.2.vsix`.
