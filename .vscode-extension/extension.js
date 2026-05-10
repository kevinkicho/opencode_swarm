// Minimal VS Code extension for opencode_swarm
// Shows run status in status bar, opens timeline in webview.
// Install: copy this directory to ~/.vscode/extensions/opencode-swarm/

const vscode = require('vscode');

const SWARM_URL = 'http://localhost:8044';

function activate(context) {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'opencode-swarm.showTimeline';
  statusBar.text = '$(sync~spin) Swarm';
  statusBar.tooltip = 'Checking swarm status...';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Poll swarm status
  let pollInterval;
  async function pollStatus() {
    try {
      const res = await fetch(`${SWARM_URL}/api/swarm/runs`);
      if (!res.ok) throw new Error('unreachable');
      const data = await res.json();
      const active = data.filter(r => r.status === 'live' || r.status === 'idle');
      if (active.length > 0) {
        statusBar.text = `$(pulse) Swarm: ${active.length} active`;
        statusBar.backgroundColor = undefined;
      } else {
        statusBar.text = '$(circle-outline) Swarm: idle';
      }
      statusBar.tooltip = `${data.length} total runs`;
    } catch {
      statusBar.text = '$(circle-slash) Swarm';
      statusBar.tooltip = 'Swarm unreachable';
    }
  }
  pollStatus();
  pollInterval = setInterval(pollStatus, 5000);
  context.subscriptions.push({ dispose: () => clearInterval(pollInterval) });

  // Command: Show timeline
  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-swarm.showTimeline', () => {
      const panel = vscode.window.createWebviewPanel(
        'swarmTimeline',
        'Swarm Timeline',
        vscode.ViewColumn.Two,
        { enableScripts: true }
      );
      panel.webview.html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;height:100vh;">
<iframe src="${SWARM_URL}" style="width:100%;height:100%;border:none;"></iframe>
</body></html>`;
    })
  );

  // Command: Start run
  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-swarm.newRun', async () => {
      const workspace = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      if (!workspace) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
      }
      // Open the swarm UI in browser for run configuration
      vscode.env.openExternal(vscode.Uri.parse(`${SWARM_URL}`));
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
