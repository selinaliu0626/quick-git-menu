const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');
const GitContentProvider = new (class {
    provideTextDocumentContent(uri) {
        const rootPath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        const [ref, ...pathParts] = uri.path.split('/');
        const filePath = pathParts.join('/');

        return new Promise((resolve, reject) => {
            // This runs: git show HEAD:src/index.js
            exec(`git show ${ref}:${filePath}`, { cwd: rootPath }, (err, stdout) => {
                if (err) resolve("Error: File does not exist in this reference.");
                else resolve(stdout);
            });
        });
    }
})();

function activate(context) {
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('git-content', GitContentProvider)
    );
    const rootPath = () => vscode.workspace.workspaceFolders?.[0].uri.fsPath;

    // Command 1: Local
    context.subscriptions.push(vscode.commands.registerCommand('super-git-helper.localMenu', () => {
        if (!rootPath()) return vscode.window.showErrorMessage("Open a project!");
        showBranchList(rootPath(), 'LOCAL');
    }));

    // Command 2: Remote
    context.subscriptions.push(vscode.commands.registerCommand('super-git-helper.remoteMenu', () => {
        if (!rootPath()) return vscode.window.showErrorMessage("Open a project!");
        showBranchList(rootPath(), 'REMOTE');
    }));

    // Command 3: Create
    context.subscriptions.push(vscode.commands.registerCommand('super-git-helper.createBranch', async () => {
        if (!rootPath()) return vscode.window.showErrorMessage("Open a project!");
        const name = await vscode.window.showInputBox({ prompt: 'New branch name' });
        if (name) runGit(`git checkout -b ${name}`, rootPath(), `Created ${name}`);
    }));
    // --- NEW Command 4: Compare/Diff Files ---
    context.subscriptions.push(vscode.commands.registerCommand('super-git-helper.listChangedFiles', async () => {
        if (!rootPath()) return vscode.window.showErrorMessage("Open a project!");
        // This is the function we wrote in the previous step
        await listChangedFilesLogic(rootPath());
    }));
}
async function listChangedFilesLogic(rootPath) {
    // 1. Get changed files (git status --short)
    // Status codes: M = Modified, A = Added, D = Deleted, ?? = Untracked
    exec('git status --short', { cwd: rootPath }, async (err, stdout) => {
        if (err) return vscode.window.showErrorMessage("Git Status Error: " + err.message);

        const files = stdout.split('\n')
            .filter(line => line.trim() !== "")
            .map(line => {
                const status = line.substring(0, 2).trim();
                const filePath = line.substring(3).trim();
                return {
                    label: `$(file-code) ${filePath}`,
                    detail: `Status: ${status}`,
                    filePath: filePath
                };
            });

        if (files.length === 0) {
            return vscode.window.showInformationMessage("No changes detected in this repo.");
        }

        // 2. User picks which file to look at
        const selected = await vscode.window.showQuickPick(files, {
            title: 'Step 1: Select File to Compare'
        });
        if (!selected) return;

        // 3. User chooses what to compare it against
        const mode = await vscode.window.showQuickPick([
            { label: 'Compare with HEAD (Uncommitted changes)', id: 'HEAD' },
            { label: 'Compare with another Branch...', id: 'BRANCH' }
        ], { title: 'Step 2: Choose Reference' });

        if (!mode) return;

        if (mode.id === 'HEAD') {
            diffWithReference(rootPath, selected.filePath, 'HEAD');
        } else {
            // Fetch all branches so the user can pick a "Parent" to compare against
            exec('git branch -a', { cwd: rootPath }, async (err, stdout) => {
                if (err) return vscode.window.showErrorMessage(err.message);

                const branches = stdout.split('\n')
                    .map(b => b.replace('*', '').trim())
                    .filter(b => b !== "");

                const targetBranch = await vscode.window.showQuickPick(branches, {
                    title: 'Step 3: Pick Branch to Compare Against'
                });

                if (targetBranch) {
                    diffWithReference(rootPath, selected.filePath, targetBranch);
                }
            });
        }
    });
}
async function diffWithReference(rootPath, filePath, reference) {
    const rightSide = vscode.Uri.file(path.join(rootPath, filePath));

    // Construct our custom URI: git-content://HEAD/path/to/file.js
    const leftSide = vscode.Uri.parse(`git-content:${reference}/${filePath}`);

    try {
        await vscode.commands.executeCommand(
            'vscode.diff',
            leftSide,
            rightSide,
            `${filePath} (Diff vs ${reference})`
        );
    } catch (e) {
        vscode.window.showErrorMessage("Diff failed: " + e.message);
    }
}

async function showBranchList(rootPath, type) {
    const cmd = type === 'LOCAL' ? 'git branch' : 'git branch -r';

    exec(cmd, { cwd: rootPath }, async (err, stdout) => {
        if (err) return vscode.window.showErrorMessage(err.message);

        const branches = stdout.split('\n')
            .map(b => b.replace('*', '').trim())
            .filter(b => b !== "" && !b.includes('->'));

        const selectedBranch = await vscode.window.showQuickPick(branches, {
            placeHolder: `Select a ${type.toLowerCase()} branch`,
            title: `Git Helper: ${type} Branches`
        });

        if (!selectedBranch) return;

        // --- SUB-MENU LOGIC STARTS HERE ---
        if (type === 'REMOTE') {
            const action = await vscode.window.showQuickPick([
                {
                    label: "$(plus) Create local branch from this",
                    id: 'CREATE_TRACK',
                    detail: `Will create a local branch linked to ${selectedBranch}`
                },
                {
                    label: "$(trash) Delete remote branch",
                    id: 'DELETE_REMOTE',
                    detail: "Warning: This deletes the branch on the server!"
                },
                {
                    label: "$(clippy) Copy name",
                    id: 'COPY'
                }
            ], { title: `Actions for ${selectedBranch}` });

            if (!action) return;

            if (action.id === 'CREATE_TRACK') {
                const suggestedName = selectedBranch.replace(/^[^/]+\//, '');
                const localName = await vscode.window.showInputBox({
                    prompt: 'Enter local branch name:',
                    value: suggestedName
                });

                if (localName) {
                    // This sets the remote parent (upstream) automatically
                    runGit(`git checkout -b ${localName} --track ${selectedBranch}`, rootPath, `Created ${localName} tracking ${selectedBranch}`);
                }
            } else if (action.id === 'DELETE_REMOTE') {
                // Splits 'origin/branch-name' into 'origin' and 'branch-name'
                const [remote, ...branchParts] = selectedBranch.split('/');
                const branchName = branchParts.join('/');

                const confirm = await vscode.window.showWarningMessage(`Are you sure you want to delete ${selectedBranch} from the server?`, "Yes", "No");
                if (confirm === "Yes") {
                    runGit(`git push ${remote} --delete ${branchName}`, rootPath, `Deleted remote branch ${selectedBranch}`);
                }
            } else if (action.id === 'COPY') {
                vscode.env.clipboard.writeText(selectedBranch);
                vscode.window.showInformationMessage("Copied to clipboard!");
            }

        } else {
            // LOCAL Branch Sub-menu
            const action = await vscode.window.showQuickPick(['Checkout', 'Delete (Safe)', 'Delete (Force)']);
            if (action === 'Checkout') runGit(`git checkout ${selectedBranch}`, rootPath, `Switched to ${selectedBranch}`);
            if (action === 'Delete (Safe)') runGit(`git branch -d ${selectedBranch}`, rootPath, `Deleted ${selectedBranch}`);
            if (action === 'Delete (Force)') runGit(`git branch -D ${selectedBranch}`, rootPath, `Force deleted ${selectedBranch}`);
        }
    });
}


function runGit(command, cwd, successMsg) {
    exec(command, { cwd }, (err, stdout, stderr) => {
        if (err) return vscode.window.showErrorMessage(stderr || err.message);
        vscode.window.showInformationMessage(successMsg);
    });
}

exports.activate = activate;