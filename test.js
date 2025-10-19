const pa11y = require('pa11y');
const XLSX = require('xlsx');
// const fetch = require('node-fetch'); // Použijeme node-fetch pro HTTP requesty (již není potřeba v Node.js v18+)
const cheerio = require('cheerio');   // Použijeme cheerio pro parsování HTML
const { URL } = require('url');       // Pro práci s URL adresami

// --- Konfigurace ---
const START_URL = 'https://example.com'; // Zde zadejte počáteční URL vašeho webu
const MAX_CRAWL_DEPTH = 2; // Hloubka pro procházení webu (0 = jen startovní URL, 1 = startovní URL + odkazy z ní, atd.)
const EXCEL_FILE = 'wcag_crawl_results.xlsx'; // Název výstupního Excel souboru
const PA11Y_OPTIONS = {
    reporter: 'json',
    standard: 'WCAG2AA', // Např. WCAG2A, WCAG2AA, WCAG2AAA
    includeWarnings: true,
    includeNotices: true,
    wait: 5000, // Počkat 5 sekund před spuštěním testu
};
const MAX_PAGES_TO_CRAWL = 100; // Omezí počet stránek, které crawler prohledá
// --- Konec konfigurace ---

const visitedUrls = new Set(); // Pro sledování již navštívených URL
const urlsToTest = [];         // Seznam URL, které Pa11y otestuje
const allIssues = [];          // Všechny nalezené problémy

// Funkce pro získání základní domény z URL
function getBaseUrl(url) {
    try {
        const urlObj = new URL(url);
        return `${urlObj.protocol}//${urlObj.host}`;
    } catch (e) {
        console.error(`Neplatná URL pro získání základní domény: ${url}`);
        return null;
    }
}

// Základní doména startovní URL, aby se crawler držel na jednom webu
const BASE_DOMAIN = getBaseUrl(START_URL);
if (!BASE_DOMAIN) {
    console.error("Neplatná startovní URL. Program bude ukončen.");
    process.exit(1);
}

// Funkce pro procházení webu
async function crawl(currentUrl, depth) {
    if (depth > MAX_CRAWL_DEPTH || visitedUrls.has(currentUrl) || urlsToTest.length >= MAX_PAGES_TO_CRAWL) {
        return;
    }

    try {
        const urlObj = new URL(currentUrl);
        // Ujisti se, že zůstáváme na stejné doméně
        if (getBaseUrl(currentUrl) !== BASE_DOMAIN) {
            console.log(`Přeskočeno (externí odkaz): ${currentUrl}`);
            return;
        }

        console.log(`Crawling (hloubka ${depth}): ${currentUrl}`);
        visitedUrls.add(currentUrl);
        urlsToTest.push(currentUrl); // Přidáme URL k testování Pa11y

        const response = await fetch(currentUrl, { timeout: 10000 }); // Nastavíme timeout na 10 sekund
        if (!response.ok) {
            console.warn(`  Chyba HTTP ${response.status} při stahování: ${currentUrl}`);
            return;
        }

        const html = await response.text();
        const $ = cheerio.load(html);

        $('a').each((i, link) => {
            const href = $(link).attr('href');
            if (href) {
                try {
                    const absoluteUrl = new URL(href, currentUrl).href;
                    // Zkontroluj, zda je to interní odkaz a ještě jsme ho nenavštívili
                    if (getBaseUrl(absoluteUrl) === BASE_DOMAIN && !visitedUrls.has(absoluteUrl) && urlsToTest.length < MAX_PAGES_TO_CRAWL) {
                        crawl(absoluteUrl, depth + 1); // Rekurzivně crawluj dál
                    }
                } catch (e) {
                    // console.warn(`  Neplatný odkaz nalezen: ${href} na ${currentUrl}`);
                }
            }
        });

    } catch (error) {
        console.error(`  Chyba při crawlingu ${currentUrl}:`, error.message);
    }
}

// Hlavní funkce pro spuštění celého procesu
async function runAccessibilityCrawlAndExport() {
    console.log(`Spouštění web crawleru od: ${START_URL} (hloubka: ${MAX_CRAWL_DEPTH})`);
    await crawl(START_URL, 0); // Spustíme crawling od počáteční URL s hloubkou 0
    console.log(`Crawler dokončen. Nalezeno ${urlsToTest.length} URL adres pro testování.`);

    if (urlsToTest.length === 0) {
        console.log('Nebyly nalezeny žádné URL adresy k testování.');
        return;
    }

    console.log('Spouštění testů přístupnosti s Pa11y pro nalezené URL...');
    for (const url of urlsToTest) {
        console.log(`Testování: ${url}...`);
        try {
            const results = await pa11y(url, PA11Y_OPTIONS);

            if (results.issues && results.issues.length > 0) {
                results.issues.forEach(issue => {
                    allIssues.push({
                        'Tested URL': url,
                        'Document Title': results.documentTitle,
                        'Issue Type': issue.type, // error, warning, notice
                        'WCAG Code': issue.code,
                        'Message': issue.message,
                        'Context': issue.context,
                        'Selector': issue.selector,
                        'Runner': issue.runner,
                        'Runner Extras': JSON.stringify(issue.runnerExtras)
                    });
                });
                console.log(`  Nalezeno ${results.issues.length} problémů na ${url}`);
            } else {
                console.log(`  Žádné problémy nenalezeny na ${url}`);
            }

        } catch (error) {
            console.error(`  Chyba při testování URL ${url}:`, error.message);
            allIssues.push({
                'Tested URL': url,
                'Document Title': 'N/A',
                'Issue Type': 'Error (Pa11y)',
                'WCAG Code': 'N/A',
                'Message': `Nepodařilo se otestovat stránku: ${error.message}`,
                'Context': 'N/A',
                'Selector': 'N/A',
                'Runner': 'N/A',
                'Runner Extras': 'N/A'
            });
        }
    }

    if (allIssues.length === 0) {
        console.log('Žádné problémy přístupnosti nebyly nalezeny na žádné z testovaných stránek.');
        return;
    }

    // Převod dat do formátu pro XLSX
    const worksheet = XLSX.utils.json_to_sheet(allIssues);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'WCAG Issues');

    // Uložení do Excel souboru
    try {
        XLSX.writeFile(workbook, EXCEL_FILE);
        console.log(`Výsledky byly úspěšně uloženy do souboru: ${EXCEL_FILE}`);
    } catch (error) {
        console.error(`Chyba při ukládání Excel souboru:`, error.message);
    }
}

// Spuštění hlavního procesu
runAccessibilityCrawlAndExport();