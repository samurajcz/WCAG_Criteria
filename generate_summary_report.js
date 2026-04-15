const fs = require('fs');
const parse = require('csv-parse').parse;
const { URL } = require('url');

// --- Konfigurace pro souhrnný report ---
const DETAIL_CSV_FILE = 'wcag_all_websites_results_detail.csv'; // Název detailního CSV souboru z prvního skriptu
const SUMMARY_REPORT_FILE = 'wcag_domain_summary_report.txt'; // Výstupní soubor pro souhrnný report
const SUMMARY_CSV_FILE = 'wcag_domain_summary_report.csv'; // Nový výstupní soubor pro CSV souhrn
// --- Konec konfigurace ---

// Funkce getWcagLevel musí být definována i zde pro parsování WCAG kódů
function getWcagLevel(wcagCode) {
    if (wcagCode.includes('WCAG2A')) return 'WCAG2A';
    if (wcagCode.includes('WCAG2AA')) return 'WCAG2AA';
    if (wcagCode.includes('WCAG2AAA')) return 'WCAG2AAA';
    return 'UNKNOWN';
}

async function generateDomainSummary() {
    console.log(`Načítání detailních výsledků z ${DETAIL_CSV_FILE}...`);
    let records;
    try {
        const fileContent = fs.readFileSync(DETAIL_CSV_FILE, 'utf8');
        records = await new Promise((resolve, reject) => {
            parse(fileContent, {
                columns: true,
                skip_empty_lines: true
            }, (err, output) => {
                if (err) reject(err);
                resolve(output);
            });
        });
    } catch (error) {
        console.error(`Chyba při čtení nebo parsování ${DETAIL_CSV_FILE}:`, error.message);
        if (error.code === 'ENOENT') {
            console.error('Ujistěte se, že jste spustili první skript a vygenerovali soubor s detaily.');
        }
        return;
    }

    if (records.length === 0) {
        console.log('Detailní CSV soubor neobsahuje žádná data.');
        return;
    }

    const domainData = {}; // Objekt pro uložení agregovaných dat pro každou doménu

    records.forEach(row => {
        const rootUrl = row['Website_Root_URL'];
        const testedUrl = row['Tested_URL'];
        const automatedAAPass = String(row['Automated_AA_Pass']).toLowerCase() === 'true';
        const totalPenaltyScorePage = parseFloat(row['Total_Penalty_Score_Page']) || 0;
        const totalPenaltyScoreErrorsOnlyPage = parseFloat(row['Total_Penalty_Score_ErrorsOnly_Page']) || 0; // NOVÉ
        const aaaIssueCountPage = parseInt(row['AAA_Issue_Count_Page'], 10) || 0;
        const issueType = row['Issue_Type'];
        const wcagCode = row['WCAG_Code'];
        const issuePenaltyScore = parseFloat(row['Issue_Penalty_Score']) || 0; // NOVÉ

        if (!domainData[rootUrl]) {
            domainData[rootUrl] = {
                pagesTested: new Set(),
                pagesPassingAAErrors: 0, // Počet stránek, které prošly A/AA bez chyb
                pagesWithAAErrors: new Set(), // Set stránek s A/AA chybami (pro unikátní počet)
                totalPages: 0,
                totalPenaltyScoreSumPages: 0, // Suma skóre za stránky (Total_Penalty_Score_Page)
                totalPenaltyScoreErrorsOnlySumPages: 0, // Suma skóre chyb za stránky
                totalAAAIssuesSumPages: 0, // Suma AAA problémů za stránky
                totalDomainPenaltyScore: 0, // NOVÉ: Celkové skóre domény (součet Issue_Penalty_Score)
                totalDomainErrorPenaltyScore: 0, // NOVÉ: Celkové skóre domény (jen za chyby)
                totalA_AA_Errors_Count: 0, // Počet jednotlivých A/AA errorů
                totalWarnings_Count: 0, // Počet jednotlivých warningů
                totalNotices_Count: 0, // Počet jednotlivých notice
                uniqueWcagCodes: new Set() // NOVÉ: Pro unikátní WCAG kódy
            };
        }

        // Agregace pro unikátní stránky
        if (!domainData[rootUrl].pagesTested.has(testedUrl)) {
            domainData[rootUrl].pagesTested.add(testedUrl);
            if (automatedAAPass) {
                domainData[rootUrl].pagesPassingAAErrors++;
            }
            if (!automatedAAPass && testedUrl !== 'N/A') { // Zaznamenej stránky, které neprošly
                domainData[rootUrl].pagesWithAAErrors.add(testedUrl);
            }
            domainData[rootUrl].totalPenaltyScoreSumPages += totalPenaltyScorePage;
            domainData[rootUrl].totalPenaltyScoreErrorsOnlySumPages += totalPenaltyScoreErrorsOnlyPage; // NOVÉ
            domainData[rootUrl].totalAAAIssuesSumPages += aaaIssueCountPage; // toto už je suma problémů, ne skóre
        }

        // Agregace pro jednotlivé problémy
        if (issueType !== 'N/A' && issueType !== 'Error (Pa11y Failed)') { // Skutečný WCAG problém
            domainData[rootUrl].totalDomainPenaltyScore += issuePenaltyScore; // NOVÉ
            if (issueType === 'error') {
                domainData[rootUrl].totalDomainErrorPenaltyScore += issuePenaltyScore; // NOVÉ
            }

            const level = getWcagLevel(wcagCode);
            if (issueType === 'error' && (level === 'WCAG2A' || level === 'WCAG2AA')) {
                domainData[rootUrl].totalA_AA_Errors_Count++;
            }
            if (issueType === 'warning') {
                domainData[rootUrl].totalWarnings_Count++;
            }
            if (issueType === 'notice') {
                domainData[rootUrl].totalNotices_Count++;
            }
            if (wcagCode !== 'N/A') {
                domainData[rootUrl].uniqueWcagCodes.add(wcagCode); // NOVÉ
            }
        }
    });

    let reportContent = '';
    reportContent += `*** Souhrnný Report Přístupnosti Webových Domén ***\n`;
    reportContent += `Datum: ${new Date().toLocaleString()}\n`;
    reportContent += `--------------------------------------------------\n\n`;

    const summaryReportData = []; // Pro CSV souhrn
    summaryReportData.push([
        'Webová Doména',
        'Celkový počet otestovaných stránek',
        '% Stránek, které prošly (0 A/AA chyb)',
        'Počet stránek s chybami A/AA', // NOVÉ
        'Celkové penalizační skóre domény (všechny problémy)', // NOVÉ
        'Celkové penalizační skóre domény (jen chyby)', // NOVÉ
        'Průměrné penalizační skóre na stránku',
        'Celkový počet A/AA chyb (na celém webu)',
        'Celkový počet varování (na celém webu)',
        'Celkový počet upozornění (na celém webu)',
        'Celkový počet AAA problémů (na celém webu)',
        'Počet unikátních WCAG kódů s problémy', // NOVÉ
        'Celkové hodnocení domény'
    ]);


    for (const rootUrl in domainData) {
        const data = domainData[rootUrl];
        data.totalPages = data.pagesTested.size;

        const percentagePassingAA = data.totalPages > 0
            ? ((data.pagesPassingAAErrors / data.totalPages) * 100).toFixed(2)
            : 0;
        const averagePenaltyScorePage = data.totalPages > 0
            ? (data.totalPenaltyScoreSumPages / data.totalPages).toFixed(2)
            : 0;
        const numPagesWithAAErrors = data.pagesWithAAErrors.size; // NOVÉ

        let domainRating = "N/A";
        if (percentagePassingAA == 100 && data.totalA_AA_Errors_Count == 0) {
            domainRating = "Výborná (žádné A/AA chyby na žádné stránce)";
        } else if (percentagePassingAA >= 80 && data.totalA_AA_Errors_Count < 10) {
            domainRating = "Dobrá (většina stránek OK, málo A/AA chyb)";
        } else if (percentagePassingAA >= 50 && data.totalA_AA_Errors_Count < 30) {
            domainRating = "Potřebuje výrazné zlepšení";
        } else {
            domainRating = "Nepřístupná (mnoho A/AA chyb)";
        }


        reportContent += `Webová Doména: ${rootUrl}\n`;
        reportContent += `  Celkový počet otestovaných stránek: ${data.totalPages}\n`;
        reportContent += `  % Stránek, které prošly (0 A/AA chyb): ${percentagePassingAA}%\n`;
        reportContent += `  Počet stránek s chybami úrovně A/AA: ${numPagesWithAAErrors}\n`; // NOVÉ
        reportContent += `  Celkové penalizační skóre domény (všechny problémy): ${data.totalDomainPenaltyScore}\n`; // NOVÉ
        reportContent += `  Celkové penalizační skóre domény (jen chyby): ${data.totalDomainErrorPenaltyScore}\n`; // NOVÉ
        reportContent += `  Průměrné penalizační skóre na stránku: ${averagePenaltyScorePage}\n`;
        reportContent += `  Celkový počet A/AA chyb (na celém webu): ${data.totalA_AA_Errors_Count}\n`;
        reportContent += `  Celkový počet varování (na celém webu): ${data.totalWarnings_Count}\n`;
        reportContent += `  Celkový počet upozornění (na celém webu): ${data.totalNotices_Count}\n`;
        reportContent += `  Celkový počet AAA problémů (na celém webu): ${data.totalAAAIssuesSumPages}\n`;
        reportContent += `  Počet unikátních WCAG kódů s problémy: ${data.uniqueWcagCodes.size}\n`; // NOVÉ
        reportContent += `  **Celkové hodnocení domény:** ${domainRating}\n`;
        reportContent += `--------------------------------------------------\n\n`;

        // Data pro CSV souhrn
        summaryReportData.push([
            rootUrl,
            data.totalPages,
            percentagePassingAA,
            numPagesWithAAErrors,
            data.totalDomainPenaltyScore,
            data.totalDomainErrorPenaltyScore,
            averagePenaltyScorePage,
            data.totalA_AA_Errors_Count,
            data.totalWarnings_Count,
            data.totalNotices_Count,
            data.totalAAAIssuesSumPages,
            data.uniqueWcagCodes.size,
            domainRating
        ]);
    }

    try {
        fs.writeFileSync(SUMMARY_REPORT_FILE, reportContent, 'utf8');
        console.log(`\nSouhrnný report (TXT) byl úspěšně uložen do souboru: ${SUMMARY_REPORT_FILE}`);
    } catch (error) {
        console.error(`Chyba při ukládání souhrnného reportu (TXT):`, error.message);
    }

    // Uložení souhrnného reportu do CSV
    try {
        const worksheet = XLSX.utils.aoa_to_sheet(summaryReportData); // XLSX.utils.aoa_to_sheet pro pole polí
        const csv = XLSX.utils.sheet_to_csv(worksheet);
        fs.writeFileSync(SUMMARY_CSV_FILE, csv, 'utf8');
        console.log(`Souhrnný report (CSV) byl úspěšně uložen do souboru: ${SUMMARY_CSV_FILE}`);
    } catch (error) {
        console.error(`Chyba při ukládání souhrnného reportu (CSV):`, error.message);
    }
}

generateDomainSummary();