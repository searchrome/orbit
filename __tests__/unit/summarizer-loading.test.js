const fs = require('node:fs');
const path = require('node:path');

function loadSummarizer() {
  const source = fs.readFileSync(path.join(__dirname, '../../summarizer.js'), 'utf8')
    .replace(/export default Summarizer;\s*$/, 'module.exports = Summarizer;');
  const module = { exports: {} };
  new Function('module', 'exports', source)(module, module.exports);
  return module.exports;
}

describe('Summarizer loading feedback', () => {
  beforeEach(() => {
    document.getElementById = Document.prototype.getElementById.bind(document);
    document.body.innerHTML = `
      <button id="summarize-btn"></button>
      <div id="summary-panel" class="hidden"><button id="close-summary-btn"></button><div id="summary-content"></div></div>
    `;
  });

  test('opens the summary panel with animated progress immediately', () => {
    const Summarizer = loadSummarizer();
    const summarizer = new Summarizer({ getURL: jest.fn() }, document.getElementById('summarize-btn'));

    summarizer.showLoadingState();

    expect(document.getElementById('summary-panel').classList.contains('hidden')).toBe(false);
    expect(document.querySelectorAll('.summary-loading__dots i')).toHaveLength(3);
    expect(document.getElementById('summary-content').textContent).toContain('Preparing your summary');
  });
});
