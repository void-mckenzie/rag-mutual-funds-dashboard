// Global variables
let fullData = null;
let allSnapshots = []; // To store the processed snapshot data
const charts = {};
const CHART_COLORS = ['#007bff', '#28a745', '#ffc107', '#dc3545', '#17a2b8', '#6610f2', '#fd7e14', '#20c997'];

document.addEventListener('DOMContentLoaded', () => {

    // --- NEW: Theme handling at page load ---
    const themeToggle = document.getElementById('theme-toggle');
    const storedTheme = localStorage.getItem('theme');

    if (storedTheme === 'dark') {
        document.body.classList.add('dark-mode');
        themeToggle.checked = true;
    }

    async function initializeDashboard() {
        try {
            const [transactionResponse, snapshotResponse] = await Promise.all([
                fetch('../data/data.json'),
                fetch('../data/snapshot_data_updated.jsonl')
            ]);
    
            if (!transactionResponse.ok) throw new Error(`HTTP error! status: ${transactionResponse.status}`);
            if (!snapshotResponse.ok) throw new Error(`HTTP error! status: ${snapshotResponse.status}`);
    
            const transactionData = await transactionResponse.json();
            const snapshotText = await snapshotResponse.text();
            allSnapshots = snapshotText.trim().split('\n').map(line => JSON.parse(line));
    
            // --- NEW: Build a comprehensive master fund list ---
            const masterFundMap = new Map();
    
            // 1. Add funds from transaction data
            transactionData.fundDetails.forEach(fh => {
                fh.folios.forEach(folio => {
                    if (!masterFundMap.has(folio.isin)) {
                        masterFundMap.set(folio.isin, { ...folio, fundHouse: fh.fundHouse });
                    }
                });
            });
    
            // 2. Add any new funds found only in snapshots
            allSnapshots.forEach(snap => {
                snap.holdings.forEach(holding => {
                    if (holding.ISIN && !masterFundMap.has(holding.ISIN)) {
                        masterFundMap.set(holding.ISIN, {
                            isin: holding.ISIN,
                            schemeName: holding.schemeName,
                            fundHouse: holding.fundHouse,
                            transactions: [], // It has no transaction history in data.json
                            valuation: {}
                        });
                    }
                });
            });
    
            // 3. Reconstruct fullData from the master list
            const fundsByHouse = {};
            masterFundMap.forEach((folio, isin) => {
                if (!fundsByHouse[folio.fundHouse]) {
                    fundsByHouse[folio.fundHouse] = {
                        fundHouse: folio.fundHouse,
                        folios: []
                    };
                }
                // Ensure we use the original transaction data if it exists
                const originalFolio = transactionData.fundDetails.flatMap(fh => fh.folios).find(f => f.isin === isin) || folio;
                fundsByHouse[folio.fundHouse].folios.push(originalFolio);
            });
            
            fullData = { ...transactionData, fundDetails: Object.values(fundsByHouse) };
            // --- END of new logic ---
    
    
            console.log("--- Data and Snapshots Initialized ---");
            setupControls();
            recalculatePortfolioSummary(fullData);
            updateDashboard(fullData);
        } catch (error) {
            console.error("Could not load dashboard data:", error);
        }
    }

    function updateDashboard(data) {
        // Use the growth data for the KPIs
        const growthData = calculateGrowthData(data, allSnapshots);

        updateKPIs(growthData); // Pass growthData instead of data
        renderPortfolioGrowthChart(data, allSnapshots);
        renderFundAllocationChart(data);
        renderProfitContributionChart(data);
        renderCostVsMarketChart(data);
    }

    function setupControls() {
        populateFundSelector(fullData);
        document.getElementById('apply-filters-button').addEventListener('click', applyFiltersAndRedraw);
        // --- NEW: Add event listener for the group by toggle ---
        document.querySelectorAll('input[name="groupBy"]').forEach(t => t.addEventListener('change', applyFiltersAndRedraw));
        document.querySelectorAll('input[name="growthChartView"]').forEach(t => t.addEventListener('change', applyFiltersAndRedraw));
        document.querySelectorAll('input[name="growthChartType"]').forEach(t => t.addEventListener('change', applyFiltersAndRedraw));
        document.getElementById('fund-selector').addEventListener('change', applyFiltersAndRedraw);
        
        // --- NEW: Theme toggle event listener ---
        themeToggle.addEventListener('change', () => {
            if (themeToggle.checked) {
                document.body.classList.add('dark-mode');
                localStorage.setItem('theme', 'dark');
            } else {
                document.body.classList.remove('dark-mode');
                localStorage.setItem('theme', 'light');
            }
            // Redraw all charts to apply new theme colors
            applyFiltersAndRedraw();
        });
    }

    function applyFiltersAndRedraw() {
        if (!fullData) return;
        const selectedIsins = Array.from(document.querySelectorAll('#fund-selector input:checked')).map(cb => cb.id);
        const startDate = document.getElementById('startDate').value;
        const endDate = document.getElementById('endDate').value;
        let filteredData = JSON.parse(JSON.stringify(fullData));
        filteredData.fundDetails.forEach(fundHouse => {
            fundHouse.folios = fundHouse.folios.filter(folio => selectedIsins.includes(folio.isin));
        });
        filteredData.fundDetails = filteredData.fundDetails.filter(fundHouse => fundHouse.folios.length > 0);
        filteredData.fundDetails.forEach(fundHouse => {
            fundHouse.folios.forEach(folio => {
                folio.transactions = folio.transactions.filter(t => {
                    const isStampDuty = t.description.toLowerCase().includes('stamp duty');
                    if (isStampDuty) return false;
                    if (startDate || endDate) {
                        const tDate = new Date(t.date);
                        const start = startDate ? new Date(startDate) : new Date('1970-01-01');
                        const end = endDate ? new Date(endDate) : new Date('9999-12-31');
                        return tDate >= start && tDate <= end;
                    }
                    return true;
                });
            });
        });
        recalculatePortfolioSummary(filteredData);
        updateDashboard(filteredData);
    }
    
    function recalculatePortfolioSummary(filteredData) {
        let grandTotalCost = 0;
        let grandTotalMarketValue = 0;
        const summaryHoldings = [];
        
        const isGroupByFundHouse = document.getElementById('group-by-fund-house').checked;
    
        filteredData.fundDetails.forEach(fundHouse => {
            fundHouse.folios.forEach(folio => {
                let finalCostValue = 0;
                let marketValue = 0;
    
                // --- THIS IS THE NEW LOGIC ---
                if (folio.transactions.length > 0) {
                    // If the fund has transactions, calculate as before.
                    let purchaseLots = [];
                    let currentCost = 0;
                    const sortedTransactions = folio.transactions.sort((a, b) => new Date(a.date) - new Date(b.date));
                    for (const t of sortedTransactions) {
                        if (t.units > 0 && t.amount > 0) {
                            currentCost += t.amount;
                            purchaseLots.push({ units: t.units, cost: t.amount, costPerUnit: t.amount / t.units });
                        } else if (t.description.toLowerCase().includes('redemption')) {
                            let unitsToRedeem = Math.abs(t.units);
                            let costOfRedeemedUnits = 0;
                            while (unitsToRedeem > 0 && purchaseLots.length > 0) {
                                const oldestLot = purchaseLots[0];
                                const unitsFromLot = Math.min(unitsToRedeem, oldestLot.units);
                                costOfRedeemedUnits += unitsFromLot * oldestLot.costPerUnit;
                                oldestLot.units -= unitsFromLot;
                                unitsToRedeem -= unitsFromLot;
                                if (oldestLot.units < 1e-6) purchaseLots.shift();
                            }
                            currentCost -= costOfRedeemedUnits;
                        }
                    }
                    finalCostValue = currentCost < 0 ? 0 : currentCost;
                    const lastTransaction = folio.transactions[folio.transactions.length - 1];
                    const currentBalance = lastTransaction ? lastTransaction.unitBalance : 0;
                    const valuationFolio = fullData.fundDetails.flatMap(fh => fh.folios).find(f => f.isin === folio.isin) || folio;
                    const nav = valuationFolio.valuation ? valuationFolio.valuation.nav : 0;
                    marketValue = currentBalance * nav;
    
                } else {
                    // If the fund has NO transactions, it must be from a snapshot.
                    // Find the latest snapshot for this fund.
                    let latestSnapshot = null;
                    for (let i = allSnapshots.length - 1; i >= 0; i--) {
                        const holding = allSnapshots[i].holdings.find(h => h.ISIN === folio.isin);
                        if (holding) {
                            latestSnapshot = holding;
                            break; // Found the latest one, stop searching.
                        }
                    }
                    if (latestSnapshot) {
                        finalCostValue = latestSnapshot.amountInvested;
                        marketValue = latestSnapshot.currentValuation;
                    }
                }
                // --- END OF NEW LOGIC ---
    
    
                grandTotalCost += finalCostValue;
                grandTotalMarketValue += marketValue;
                
                const key = isGroupByFundHouse ? fundHouse.fundHouse : folio.isin;
                const label = isGroupByFundHouse ? fundHouse.fundHouse : folio.schemeName;
    
                let summaryEntry = summaryHoldings.find(h => h.key === key);
                if (summaryEntry) {
                    summaryEntry.costValue += finalCostValue;
                    summaryEntry.marketValue += marketValue;
                } else {
                    summaryHoldings.push({
                        key: key,
                        label: label,
                        costValue: finalCostValue,
                        marketValue: marketValue
                    });
                }
            });
        });
    
        filteredData.portfolioSummary = {
            totals: {
                costValue: grandTotalCost,
                marketValue: grandTotalMarketValue
            },
            holdings: summaryHoldings
        };
    }
    

    function updateKPIs(growthData) {
        // If you need to fallback:
        if (!growthData) {
            document.getElementById('total-investment').textContent = `₹0.00`;
            document.getElementById('current-value').textContent = `₹0.00`;
            document.getElementById('overall-gain').textContent = `₹0.00 (0.00%)`;
            return;
        }
        console.log("growthData for KPIs", growthData);
        const totalCost = growthData.finalInvestment;
        const marketValue = growthData.finalTotalValue;
        const gain = marketValue - totalCost;
        const returnPercent = totalCost > 0 ? (gain / totalCost) * 100 : 0;
        document.getElementById('total-investment').textContent = `₹${totalCost.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
        document.getElementById('current-value').textContent = `₹${marketValue.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
        document.getElementById('overall-gain').textContent = `₹${gain.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})} (${returnPercent.toFixed(2)}%)`;
        document.getElementById('overall-gain').style.color = gain >= 0 ? 'var(--gain-color)' : 'var(--loss-color)';
    }
    
    
    function populateFundSelector(data) {
        const selectorContainer = document.getElementById('fund-selector');
        selectorContainer.innerHTML = '';
        const fundColors = {};
        data.fundDetails.forEach((fundHouse, index) => {
             fundColors[fundHouse.fundHouse] = CHART_COLORS[index % CHART_COLORS.length];
        });
        data.fundDetails.forEach((fundHouse) => {
            const color = fundColors[fundHouse.fundHouse];
            fundHouse.folios.forEach(folio => {
                const div = document.createElement('div');
                div.innerHTML = `<input type="checkbox" id="${folio.isin}" name="${folio.schemeName}" checked><label for="${folio.isin}" style="border-left: 5px solid ${color}; padding-left: 5px;">${folio.schemeName}</label>`;
                selectorContainer.appendChild(div);
            });
        });
    }

    function calculateGrowthData(data, snapshots) {
        const selectedIsins = new Set(data.fundDetails.flatMap(fh => fh.folios).map(f => f.isin));
        if (selectedIsins.size === 0) {
            return { fundDatasets: [], totalValueDataset: { data: [] }, investmentDataset: { data: [] } };
        }

        const transactionEvents = data.fundDetails.flatMap(fh => fh.folios).flatMap(folio => folio.transactions.map(t => ({ type: 'transaction', date: t.date, data: { ...t, isin: folio.isin } })));
        const snapshotEvents = snapshots.flatMap(snap => snap.holdings.filter(h => selectedIsins.has(h.ISIN)).map(holding => ({ type: 'snapshot', date: snap.statement_date, data: { ...holding, isin: holding.ISIN } })));
        const allEvents = [...transactionEvents, ...snapshotEvents].sort((a, b) => new Date(a.date) - new Date(b.date));
        
        if (allEvents.length === 0) {
            return { fundDatasets: [], totalValueDataset: { data: [] }, investmentDataset: { data: [] } };
        }

        const eventsByDate = allEvents.reduce((acc, event) => {
            (acc[event.date] = acc[event.date] || []).push(event);
            return acc;
        }, {});

        const investmentDataPoints = [];
        const totalValueDataPoints = [];
        const fundDataPoints = {};
        let fundStates = {};
        let purchaseLotsByISIN = {};

        selectedIsins.forEach(isin => {
            fundStates[isin] = { costBasis: 0, unitBalance: 0, nav: 0, value: 0 };
            fundDataPoints[isin] = [];
            purchaseLotsByISIN[isin] = [];
        });

        const minDate = new Date(allEvents[0].date);
        const lastEventDate = new Date(allEvents[allEvents.length - 1].date);
        const today = new Date();

        // The chart will now always extend to today's date, or the last event date, whichever is later.
        const maxDate = today > lastEventDate ? today : lastEventDate;

        for (let d = new Date(minDate.getTime()); d <= maxDate; d.setUTCDate(d.getUTCDate() + 1)) {
            const dateStr = d.toISOString().split('T')[0];
            const todaysEvents = eventsByDate[dateStr] || [];

            for (const event of todaysEvents) {
                const { type, data: eventData } = event;
                const { isin } = eventData;
                if (!fundStates[isin]) continue;

                if (type === 'snapshot') {
                    fundStates[isin].costBasis = eventData.amountInvested || fundStates[isin].costBasis;
                    fundStates[isin].unitBalance = eventData.closingBalanceUnits || fundStates[isin].unitBalance;
                    fundStates[isin].nav = eventData.nav || fundStates[isin].nav;
                } else if (type === 'transaction') {
                    if (eventData.units > 0 && eventData.amount > 0) {
                        fundStates[isin].costBasis += eventData.amount;
                        purchaseLotsByISIN[isin].push({ units: eventData.units, costPerUnit: eventData.amount / eventData.units });
                    } else if (eventData.description.toLowerCase().includes('redemption')) {
                        let unitsToRedeem = Math.abs(eventData.units);
                        let costOfRedeemedUnits = 0;
                        while (unitsToRedeem > 0 && purchaseLotsByISIN[isin].length > 0) {
                            const lot = purchaseLotsByISIN[isin][0];
                            const unitsFromLot = Math.min(unitsToRedeem, lot.units);
                            costOfRedeemedUnits += unitsFromLot * lot.costPerUnit;
                            lot.units -= unitsFromLot;
                            unitsToRedeem -= unitsFromLot;
                            if (lot.units < 1e-6) purchaseLotsByISIN[isin].shift();
                        }
                        fundStates[isin].costBasis -= costOfRedeemedUnits;
                    }
                    if (eventData.unitBalance != null) fundStates[isin].unitBalance = eventData.unitBalance;
                    if (eventData.nav != null) fundStates[isin].nav = eventData.nav;
                }
            }

            let portfolioTotalInvestment = 0;
            let portfolioTotalValue = 0;

            selectedIsins.forEach(isin => {
                const state = fundStates[isin];
                state.value = state.unitBalance * state.nav;
                portfolioTotalInvestment += state.costBasis;
                portfolioTotalValue += state.value;
                fundDataPoints[isin].push({ x: d.getTime(), y: state.value });
            });

            investmentDataPoints.push({ x: d.getTime(), y: portfolioTotalInvestment < 0 ? 0 : portfolioTotalInvestment });
            totalValueDataPoints.push({ x: d.getTime(), y: portfolioTotalValue < 0 ? 0 : portfolioTotalValue });
        }

        const fundDatasets = Object.keys(fundDataPoints).map((isin) => {
            const folio = fullData.fundDetails.flatMap(fh => fh.folios).find(f => f.isin === isin);
            const originalFundHouseIndex = fullData.fundDetails.findIndex(fh => fh.folios.some(f => f.isin === isin));
            const colorIndex = originalFundHouseIndex !== -1 ? originalFundHouseIndex : 0;
            return {
                label: folio ? folio.schemeName : 'Unknown Fund',
                data: fundDataPoints[isin],
                borderColor: CHART_COLORS[colorIndex % CHART_COLORS.length],
                backgroundColor: CHART_COLORS[colorIndex % CHART_COLORS.length] + '80',
                tension: 0.1,
            };
        });
        const totalValueDataset = { label: 'Total Market Value', data: totalValueDataPoints, borderColor: '#007bff', backgroundColor: '#007bff80', tension: 0.1 };
        const investmentDataset = { label: 'Cumulative Investment', data: investmentDataPoints, borderColor: '#fd7e14', borderDash: [5, 5], fill: false, tension: 0.1, pointRadius: 0 };
        
        return {
            fundDatasets,
            totalValueDataset,
            investmentDataset,
            finalTotalValue: totalValueDataPoints.length ? totalValueDataPoints[totalValueDataPoints.length - 1].y : 0,
            finalInvestment: investmentDataPoints.length ? investmentDataPoints[investmentDataPoints.length - 1].y : 0,
        };
    }

    function renderPortfolioGrowthChart(data, snapshots) {
        if (charts.portfolioGrowth) charts.portfolioGrowth.destroy();
        
        const growthData = calculateGrowthData(data, snapshots);
        if (growthData.totalValueDataset.data.length === 0) {
            charts.portfolioGrowth = null;
            return;
        }

        const bodyStyles = getComputedStyle(document.body);
        const gridColor = bodyStyles.getPropertyValue('--border-color');
        const textColor = bodyStyles.getPropertyValue('--text-color');

        const ctx = document.getElementById('portfolioGrowthChart').getContext('2d');
        const isComparisonView = document.getElementById('comparison-view').checked;
        const isStackedArea = document.getElementById('area-chart-toggle').checked;
        const chartTypeControl = document.getElementById('chart-type-control-group');
        let datasetsToShow;
        let isStacked = false;

        if (isComparisonView) {
            datasetsToShow = [growthData.totalValueDataset, growthData.investmentDataset];
            isStacked = false;
            chartTypeControl.classList.add('disabled');
        } else {
            datasetsToShow = growthData.fundDatasets;
            isStacked = isStackedArea;
            datasetsToShow.forEach(ds => ds.fill = isStackedArea);
            chartTypeControl.classList.remove('disabled');
        }

        charts.portfolioGrowth = new Chart(ctx, {
            type: 'line',
            data: { datasets: datasetsToShow },
            options: {
                responsive: true,
                // --- NEW: Smaller points and theme-aware colors ---
                elements: {
                    point: {
                        radius: 2,
                        hoverRadius: 5
                    }
                },
                scales: { 
                    x: { 
                        type: 'time', 
                        time: { unit: 'day' }, 
                        title: { display: true, text: 'Date', color: textColor },
                        ticks: { color: textColor },
                        grid: { color: gridColor },
                        
                    }, 
                    y: { 
                        title: { display: true, text: 'Value (INR)', color: textColor }, 
                        stacked: isStacked,
                        ticks: { color: textColor },
                        grid: { color: gridColor }
                    } 
                },
                plugins: { 
                    legend: { labels: { color: textColor } },
                    tooltip: { callbacks: { label: (context) => ` ${context.dataset.label}: ₹${context.parsed.y.toLocaleString('en-IN', {maximumFractionDigits: 0})}` } }
                }
            }
        });
    }

    
    // In app.js, replace the four existing chart functions with these complete versions:

function renderFundAllocationChart(data) {
    if (charts.fundAllocation) charts.fundAllocation.destroy();
    if (!data.portfolioSummary || !data.portfolioSummary.holdings || data.portfolioSummary.holdings.length === 0) {
        charts.fundAllocation = null;
        return;
    }
    const textColor = getComputedStyle(document.body).getPropertyValue('--text-color');
    const ctx = document.getElementById('fundAllocationChart').getContext('2d');
    const labels = data.portfolioSummary.holdings.map(h => h.label); // Use .label
    const values = data.portfolioSummary.holdings.map(h => h.marketValue);
    const totalValue = values.reduce((a, b) => a + b, 0);

    charts.fundAllocation = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{ data: values, backgroundColor: CHART_COLORS }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { position: 'top', labels: { color: textColor } },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const label = context.label || '';
                            const value = context.parsed;
                            const percentage = totalValue > 0 ? ((value / totalValue) * 100).toFixed(2) : 0;
                            return `${label}: ₹${value.toLocaleString('en-IN')} (${percentage}%)`;
                        }
                    }
                }
            }
        }
    });
}

function renderProfitContributionChart(data) {
    if (charts.profitContribution) charts.profitContribution.destroy();
    if (!data.portfolioSummary || !data.portfolioSummary.holdings || data.portfolioSummary.holdings.length === 0) {
        charts.profitContribution = null;
        return;
    }
    const textColor = getComputedStyle(document.body).getPropertyValue('--text-color');
    const ctx = document.getElementById('profitContributionChart').getContext('2d');
    const labels = data.portfolioSummary.holdings.map(h => h.label); // Use .label
    const profits = data.portfolioSummary.holdings.map(h => Math.max(0, h.marketValue - h.costValue));
    const totalProfit = profits.reduce((a, b) => a + b, 0);

    charts.profitContribution = new Chart(ctx, {
        type: 'pie',
        data: {
            labels,
            datasets: [{ data: profits, backgroundColor: CHART_COLORS }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { position: 'top', labels: { color: textColor } },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const label = context.label || '';
                            const value = context.parsed;
                            const percentage = totalProfit > 0 ? ((value / totalProfit) * 100).toFixed(2) : 0;
                            return `${label}: ₹${value.toLocaleString('en-IN')} (${percentage}%)`;
                        }
                    }
                }
            }
        }
    });
}

function renderProfitLossPercentageChart(data) {
    if (charts.profitLossPercentage) charts.profitLossPercentage.destroy();
    if (!data.portfolioSummary || !data.portfolioSummary.holdings || data.portfolioSummary.holdings.length === 0) {
        charts.profitLossPercentage = null;
        return;
    }
    const bodyStyles = getComputedStyle(document.body);
    const gridColor = bodyStyles.getPropertyValue('--border-color');
    const textColor = bodyStyles.getPropertyValue('--text-color');
    const gainColor = 'rgba(40, 167, 69, 0.8)';
    const lossColor = 'rgba(220, 53, 69, 0.8)';
    const ctx = document.getElementById('profitLossPercentageChart').getContext('2d');
    const labels = data.portfolioSummary.holdings.map(h => h.label); // Use .label
    const percentages = data.portfolioSummary.holdings.map(h => {
        if (h.costValue > 0) {
            return ((h.marketValue - h.costValue) / h.costValue) * 100;
        }
        return 0;
    });
    const backgroundColors = percentages.map(p => p >= 0 ? gainColor : lossColor);

    charts.profitLossPercentage = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{ label: 'Return (%)', data: percentages, backgroundColor: backgroundColors }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            scales: {
                x: {
                    title: { display: true, text: 'Return (%)', color: textColor },
                    ticks: { color: textColor, callback: (value) => value + '%' },
                    grid: { color: gridColor }
                },
                y: { ticks: { color: textColor }, grid: { color: gridColor } }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return ` Return: ${context.parsed.x.toFixed(2)}%`;
                        }
                    }
                }
            }
        }
    });
}

function renderCostVsMarketChart(data) {
    if (charts.costVsMarket) charts.costVsMarket.destroy();
    if (!data.portfolioSummary || !data.portfolioSummary.holdings || data.portfolioSummary.holdings.length === 0) {
        charts.costVsMarket = null;
        return;
    }
    const bodyStyles = getComputedStyle(document.body);
    const gridColor = bodyStyles.getPropertyValue('--border-color');
    const textColor = bodyStyles.getPropertyValue('--text-color');
    const ctx = document.getElementById('costVsMarketChart').getContext('2d');
    const labels = data.portfolioSummary.holdings.map(h => h.label); // Use .label
    const costValues = data.portfolioSummary.holdings.map(h => h.costValue);
    const marketValues = data.portfolioSummary.holdings.map(h => h.marketValue);

    charts.costVsMarket = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{ label: 'Cost Value', data: costValues, backgroundColor: '#ffc107' }, { label: 'Market Value', data: marketValues, backgroundColor: '#28a745' }]
        },
        options: {
            responsive: true,
            indexAxis: 'y',
            scales: {
                x: { ticks: { color: textColor }, grid: { color: gridColor } },
                y: { ticks: { color: textColor }, grid: { color: gridColor } }
            },
            plugins: {
                legend: { labels: { color: textColor } },
                tooltip: {
                    callbacks: {
                        footer: function(tooltipItems) {
                            const index = tooltipItems[0].dataIndex;
                            const cost = costValues[index];
                            const market = marketValues[index];
                            if (cost > 0) {
                                const gain = market - cost;
                                const percentage = (gain / cost) * 100;
                                return `\nGain: ₹${gain.toLocaleString('en-IN', { maximumFractionDigits: 2 })} (${percentage.toFixed(2)}%)`;
                            }
                            return '';
                        }
                    }
                }
            }
        }
    });
}


function updateDashboard(data) {
    const growthData = calculateGrowthData(data, allSnapshots);
    console.log("growthData for KPIs", growthData); // <-- This should log an object with finalInvestment and finalTotalValue!
    updateKPIs(growthData); // Pass growthData here
    renderPortfolioGrowthChart(data, allSnapshots);
    renderFundAllocationChart(data);
    renderProfitContributionChart(data);
    renderCostVsMarketChart(data);
    renderProfitLossPercentageChart(data);
}
    
    initializeDashboard();
});