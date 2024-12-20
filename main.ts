import { 
	App, Plugin, PluginSettingTab, Setting, TFile, Modal, Notice
} from 'obsidian';

interface SimpleSearchSettings {
	defaultSearchTerm: string;
}

const DEFAULT_SETTINGS: SimpleSearchSettings = {
	defaultSearchTerm: ''
};

export default class SimpleSearchPlugin extends Plugin {
	settings: SimpleSearchSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'simple-search-open',
			name: 'Live Search Entire Vault',
			callback: () => {
				new LiveSearchModal(this.app, this.settings.defaultSearchTerm).open();
			}
		});

		this.addSettingTab(new SimpleSearchSettingTab(this.app, this));
	}

	onunload() {
		// Cleanup if needed
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

/** 
 * Utility Functions 
 */
function prepareSearchTerm(term: string): string {
	return term.toLowerCase().replace(/\s+/g, '_');
}

function matchesSearchTerm(text: string, searchTerm: string): boolean {
	const cleanedText = prepareSearchTerm(text);
	return cleanedText.includes(searchTerm);
}

interface SearchResult {
	file: TFile;
	matchingLines: string[];
}

/**
 * Finds all lines in `content` that match `searchTerm`.
 */
function findMatchingLines(content: string, searchTerm: string): string[] {
	const lines = content.split('\n');
	const matches: string[] = [];
	for (const line of lines) {
		if (matchesSearchTerm(line, searchTerm)) {
			matches.push(line);
		}
	}
	return matches;
}

/**
 * Perform a live search for `rawTerm` across all .md files.
 * As soon as a file is processed, this function calls `onResult` to report matches.
 * If `signal` is aborted, the search stops immediately.
 */
async function performLiveSearch(
	app: App, 
	rawTerm: string, 
	onResult: (result: SearchResult) => void,
	signal: AbortSignal
): Promise<void> {
	const searchTerm = prepareSearchTerm(rawTerm);
	if (!searchTerm) return;

	const files = app.vault.getMarkdownFiles();
	for (const file of files) {
		if (signal.aborted) return; // Stop if aborted
		const fileName = file.name;
		const fileContent = await app.vault.read(file);
		if (signal.aborted) return; // Check again after async operation

		const fileNameMatches = matchesSearchTerm(fileName, searchTerm);
		const matchingLines = findMatchingLines(fileContent, searchTerm);

		if (fileNameMatches || matchingLines.length > 0) {
			onResult({ file, matchingLines });
		}
	}
}

/**
 * Modal that allows live searching.
 */
class LiveSearchModal extends Modal {
	private inputEl: HTMLInputElement;
	private resultsContainer: HTMLDivElement;
	private debounceTimer: number | null = null;
	private currentSearchController: AbortController | null = null;
	private lastQuery: string = '';

	constructor(app: App, defaultValue: string) {
		super(app);
		this.lastQuery = defaultValue;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: 'Live Search' });

		// Input field
		this.inputEl = contentEl.createEl('input', {
			type: 'text',
			value: this.lastQuery,
			placeholder: 'Type to search...'
		});
		this.inputEl.addClass('simple-search-input');

		// Results container
		this.resultsContainer = contentEl.createDiv({ cls: 'simple-search-results' });
		this.resultsContainer.createEl('p', { text: 'Start typing to search...' });

		// Event: on input change, debounce search
		this.inputEl.addEventListener('input', () => this.onInputChanged());
		
		// Trigger initial search if defaultValue is not empty
		if (this.lastQuery.trim() !== '') {
			this.triggerSearchWithDebounce();
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		if (this.currentSearchController) {
			this.currentSearchController.abort();
		}
	}

	private onInputChanged() {
		if (this.debounceTimer) {
			window.clearTimeout(this.debounceTimer);
		}

		// If user cleared the input, reset UI
		const query = this.inputEl.value.trim();
		if (query === '') {
			this.clearResults();
			this.resultsContainer.createEl('p', { text: 'Start typing to search...' });
			if (this.currentSearchController) {
				this.currentSearchController.abort();
				this.currentSearchController = null;
			}
			return;
		}

		// Debounce: start searching after 200ms of no typing
		this.debounceTimer = window.setTimeout(() => {
			this.triggerSearch();
		}, 200);
	}

	private triggerSearchWithDebounce() {
		if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
		this.debounceTimer = window.setTimeout(() => this.triggerSearch(), 200);
	}

	private async triggerSearch() {
		const query = this.inputEl.value.trim();
		if (!query) return;

		// Abort any ongoing search
		if (this.currentSearchController) {
			this.currentSearchController.abort();
		}

		// Clear previous results
		this.clearResults();
		this.resultsContainer.createEl('p', { text: 'Searching...' });

		this.currentSearchController = new AbortController();
		const signal = this.currentSearchController.signal;

		// Store found results to update incrementally
		let foundAnyResult = false;

		await performLiveSearch(
			this.app, 
			query, 
			(result) => {
				if (signal.aborted) return;
				// On each result found, update the UI incrementally
				if (!foundAnyResult) {
					this.clearResults();
					foundAnyResult = true;
				}

				this.appendResultToUI(result);
			},
			signal
		);

		if (!signal.aborted && !foundAnyResult) {
			this.clearResults();
			this.resultsContainer.createEl('p', { text: 'No results found.' });
		}
	}

	private clearResults() {
		this.resultsContainer.empty();
	}

	private appendResultToUI(result: SearchResult) {
		const fileSection = this.resultsContainer.createDiv({ cls: 'simple-search-result' });
		fileSection.createEl('h3', { text: result.file.path });

		if (result.matchingLines.length > 0) {
			const ul = fileSection.createEl('ul');
			result.matchingLines.forEach(line => {
				ul.createEl('li', { text: line });
			});
		} else {
			fileSection.createEl('p', { text: '(Matched filename)' });
		}
	}
}

/**
 * Settings tab for the plugin.
 */
class SimpleSearchSettingTab extends PluginSettingTab {
	plugin: SimpleSearchPlugin;

	constructor(app: App, plugin: SimpleSearchPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();
		containerEl.createEl('h2', { text: 'Simple Search Settings' });

		new Setting(containerEl)
			.setName('Default Search Term')
			.setDesc('The default search term that appears when opening the search modal.')
			.addText(text => text
				.setPlaceholder('Enter default search term')
				.setValue(this.plugin.settings.defaultSearchTerm)
				.onChange(async (value) => {
					this.plugin.settings.defaultSearchTerm = value;
					await this.plugin.saveSettings();
				}));
	}
}
