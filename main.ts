import { 
	App, Plugin, PluginSettingTab, Setting, TFile, Modal
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

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

/** 
 * Utility Functions 
 * We now ensure each whitespace character is replaced by a single underscore 
 * to maintain exact indexing between original and cleaned strings.
 */
function prepareSearchTerm(term: string): string {
	// Replace each whitespace char with underscore, preserving string length
	return term.toLowerCase().replace(/\s/g, '_');
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
 * Create a highlighted snippet around the matched term.
 * We know that "cleanedLine" and "cleanedSearchTerm" have the same length indexing due to 1:1 char mapping.
 */
function createHighlightedSnippet(line: string, rawTerm: string): string {
	const cleanedLine = prepareSearchTerm(line);
	const cleanedSearchTerm = prepareSearchTerm(rawTerm);

	const index = cleanedLine.indexOf(cleanedSearchTerm);
	if (index === -1) {
		// No match found (should not happen since we call this only on matches)
		return line;
	}

	// Calculate snippet boundaries (50 chars before and after)
	const snippetStart = Math.max(0, index - 50);
	const snippetEnd = Math.min(line.length, index + rawTerm.length + 50);

	let snippet = line.substring(snippetStart, snippetEnd);

	// Calculate relative index within snippet
	const relativeIndex = index - snippetStart;
	const beforeMatch = snippet.substring(0, relativeIndex);
	const matchPortion = snippet.substring(relativeIndex, relativeIndex + rawTerm.length);
	const afterMatch = snippet.substring(relativeIndex + rawTerm.length);

	const highlightedSnippet = beforeMatch + '<strong>' + matchPortion + '</strong>' + afterMatch;
	return highlightedSnippet;
}

function findMatchingLines(content: string, rawTerm: string): string[] {
	const searchTerm = prepareSearchTerm(rawTerm);
	const lines = content.split('\n');
	const matches: string[] = [];
	for (const line of lines) {
		if (matchesSearchTerm(line, searchTerm)) {
			matches.push(createHighlightedSnippet(line, rawTerm));
		}
	}
	return matches;
}

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
		if (signal.aborted) return; 
		const fileContent = await app.vault.read(file);
		if (signal.aborted) return; 

		const fileNameMatches = matchesSearchTerm(file.name, searchTerm);
		const matchingLines = findMatchingLines(fileContent, rawTerm);

		if (fileNameMatches || matchingLines.length > 0) {
			onResult({ file, matchingLines });
		}
	}
}

/**
 * Modal that allows live searching.
 * We now fix the modal height and let the results scroll.
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
		this.modalEl.addClass('simple-search-modal'); // Add a class for styling

		const { contentEl } = this;

		const titleEl = contentEl.createEl('h2', { text: 'Live Search' });
		titleEl.addClass('simple-search-title');

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

		let foundAnyResult = false;

		await performLiveSearch(
			this.app, 
			query, 
			(result) => {
				if (signal.aborted) return;
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

		// File title - clickable
		const fileTitle = fileSection.createEl('h3', { text: result.file.path, cls: 'clickable-file-link' });
		fileTitle.addClass('simple-search-file-title');
		fileTitle.addEventListener('click', () => {
			this.app.workspace.getLeaf().openFile(result.file);
		});

		if (result.matchingLines.length > 0) {
			const ul = fileSection.createEl('ul', { cls: 'search-results-list' });
			result.matchingLines.forEach(line => {
				const li = ul.createEl('li');
				li.innerHTML = line; // Insert snippet with highlighting
			});
		} else {
			fileSection.createEl('p', { text: '(Matched filename)' });
		}
	}
}

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
