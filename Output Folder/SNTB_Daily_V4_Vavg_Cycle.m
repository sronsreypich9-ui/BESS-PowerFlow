clc; clear; close all;
close all force;

%% =====================================================================
%  USER SETTINGS
%% =====================================================================
baseFolder         = 'D:\3. Matlab\1. SNTB MATCODE\Data\May\28-May-2026';  % <<< CHANGE
yesterdayESSFolder = 'D:\3. Matlab\1. SNTB MATCODE\Data\May\27-May-2026\ESS'; % <<< CHANGE

dtTick = minutes(30);

Pylim_MW    = [-40 40];
Pticks_MW   = [-40 -20 0 20 40];
Qylim_Mvar  = [-25 25];
Qticks_Mvar = [-25 -12.5 0 12.5 25];

red    = [0.8 0 0];
colVab = [0 0.447 0.741];
colVbc = [0.466 0.674 0.188];
colVca = [0.494 0.184 0.556];

%% =====================================================================
%  AUTO LOCATE SOC AND ACTIVEPOWER/REACTIVEPOWER FILES
%% =====================================================================
file_SOCFV = dir(fullfile(baseFolder, '*SOC*.xlsx'));
file_PQ    = dir(fullfile(baseFolder, '*ActivePower*ReactivePower*.xlsx'));

if isempty(file_SOCFV)
    error('Cannot find SOC/F/V file. Expect: *Voltage*SOC*POC*Point*.xlsx');
end
if isempty(file_PQ)
    error('Cannot find P/Q file. Expect: *P*Q*POC*Point*.xlsx');
end

socfvPath = fullfile(baseFolder, file_SOCFV(1).name);
pqPath    = fullfile(baseFolder, file_PQ(1).name);

fprintf('SOC/F/V file: %s\n', file_SOCFV(1).name);
fprintf('P/Q file    : %s\n', file_PQ(1).name);

%% =====================================================================
%  READ & CLEAN TABLES
%% =====================================================================
T1 = readtable(socfvPath, 'PreserveVariableNames', true);
T2 = readtable(pqPath,    'PreserveVariableNames', true);

T1 = T1(~ismember(string(T1{:,1}), ["Average","Max","Min"]), :);
T2 = T2(~ismember(string(T2{:,1}), ["Average","Max","Min"]), :);

T1.Time = datetime(string(T1{:,1}), 'InputFormat', 'yyyy-MM-dd HH:mm:ss');
T2.Time = datetime(string(T2{:,1}), 'InputFormat', 'yyyy-MM-dd HH:mm:ss');

T1 = standardizeMissing(T1, "--");
T2 = standardizeMissing(T2, "--");

vars1 = T1.Properties.VariableNames;
for i = 2:width(T1)
    col = T1.(vars1{i});
    if iscell(col) || isstring(col) || ischar(col), col = str2double(string(col)); end
    col = fillmissing(col, 'previous', 'EndValues', 'nearest');
    col = fillmissing(col, 'next');
    T1.(vars1{i}) = col;
end

vars2 = T2.Properties.VariableNames;
for i = 2:width(T2)
    col = T2.(vars2{i});
    if iscell(col) || isstring(col) || ischar(col), col = str2double(string(col)); end
    col = fillmissing(col, 'previous', 'EndValues', 'nearest');
    col = fillmissing(col, 'next');
    T2.(vars2{i}) = col;
end

T1 = T1(~isnat(T1.Time), :);
T2 = T2(~isnat(T2.Time), :);

%% =====================================================================
%  EXTRACT COLUMNS
%% =====================================================================
SOC    = T1{:,2};
F      = T1{:,3};
Vab    = T1{:,4};
Vbc    = T1{:,5};
Vca    = T1{:,6};
P_kW   = T2{:,2};
Q_kVAr = T2{:,3};

%% =====================================================================
%  TIMETABLES & ALIGN
%% =====================================================================
TT1 = timetable(T1.Time, SOC, F, Vab, Vbc, Vca, ...
    'VariableNames', {'SOC','F','Vab','Vbc','Vca'});
TT2 = timetable(T2.Time, P_kW, Q_kVAr, ...
    'VariableNames', {'P_kW','Q_kVAr'});
TT  = synchronize(TT1, TT2, 'intersection');

if height(TT) == 0
    warning('Intersection empty. Using union + fillmissing.');
    TT = synchronize(TT1, TT2, 'union');
    TT = fillmissing(TT, 'previous', 'EndValues', 'nearest');
    TT = fillmissing(TT, 'next');
end

%% =====================================================================
%  SMARTLOGGER -> TT5
%% =====================================================================
smartFolder = fullfile(baseFolder, 'SmartLogger');
smartFiles  = dir(fullfile(smartFolder, 'SmartLogger_*.xlsx'));

if isempty(smartFiles)
    warning('No SmartLogger_*.xlsx found in: %s', smartFolder);
    TT5 = timetable('Size',[0 2],'VariableTypes',{'double','double'}, ...
                    'VariableNames',{'TotalP_MW','TotalQ_MVar'}, ...
                    'RowTimes',datetime.empty(0,1));
else
    TTsumP = []; TTsumQ = [];
    for k = 1:numel(smartFiles)
        fpath = fullfile(smartFolder, smartFiles(k).name);
        Ts    = readtable(fpath,'Range','A4','PreserveVariableNames',true);
        vnames  = lower(string(Ts.Properties.VariableNames));
        idxTime = find(contains(vnames,"start") & contains(vnames,"time"),1);
        if isempty(idxTime), idxTime = find(contains(vnames,"time"),1); end
        if isempty(idxTime), idxTime = 1; end
        idxP = 5; idxQ = 26;
        t_s    = datetime(string(Ts{:,idxTime}),'InputFormat','yyyy-MM-dd HH:mm:ss');
        p_kW   = Ts{:,idxP};   if ~isnumeric(p_kW),   p_kW   = str2double(string(p_kW));   end
        q_kVAr = Ts{:,idxQ};   if ~isnumeric(q_kVAr), q_kVAr = str2double(string(q_kVAr)); end
        valid  = ~isnat(t_s);
        t_s = t_s(valid); p_kW = p_kW(valid); q_kVAr = q_kVAr(valid);
        TTkP = timetable(t_s, p_kW,   'VariableNames',{sprintf('P%d_kW',k)});
        TTkQ = timetable(t_s, q_kVAr, 'VariableNames',{sprintf('Q%d_kVAr',k)});
        if isempty(TTsumP), TTsumP = TTkP; else, TTsumP = synchronize(TTsumP,TTkP,'union'); end
        if isempty(TTsumQ), TTsumQ = TTkQ; else, TTsumQ = synchronize(TTsumQ,TTkQ,'union'); end
    end
    TTsumP = fillmissing(TTsumP,'constant',0);
    TTsumQ = fillmissing(TTsumQ,'constant',0);
    TTsumP.TotalP_MW   = sum(TTsumP{:,1:end},2) / 1000;
    TTsumQ.TotalQ_MVar = sum(TTsumQ{:,1:end},2)  / 1000;
    TT5 = synchronize(TTsumP(:,{'TotalP_MW'}), TTsumQ(:,{'TotalQ_MVar'}),'union');
    TT5 = fillmissing(TT5,'constant',0);
    disp('✅ SmartLogger SUM done -> TT5.TotalP_MW and TT5.TotalQ_MVar');
end

%% =====================================================================
%  FINAL SERIES
%% =====================================================================
t      = TT.Time;
P_MW   = TT.P_kW   / 1000;
Q_MVar = TT.Q_kVAr / 1000;
SOC    = TT.SOC;
F      = TT.F;
Vab    = TT.Vab;
Vbc    = TT.Vbc;
Vca    = TT.Vca;

%% =====================================================================
%  RAW FILE STRUCTS (ESS / PCS / SmartLogger)
%% =====================================================================
rawESS = struct(); rawPCS = struct(); rawSmart = struct();
mkField = @(fn) matlab.lang.makeValidName(erase(fn, {'.xlsx','.xls'}));

essFolder = fullfile(baseFolder, 'ESS');
if isfolder(essFolder)
    essFiles = [dir(fullfile(essFolder,'*.xlsx')); dir(fullfile(essFolder,'*.xls'))];
    for k = 1:numel(essFiles)
        fpath = fullfile(essFolder, essFiles(k).name);
        key   = mkField(essFiles(k).name);
        try,    rawESS.(key) = readtable(fpath,'PreserveVariableNames',true);
        catch,  rawESS.(key) = readtable(fpath,'PreserveVariableNames',true,'ReadVariableNames',true); end
    end
else
    warning('ESS folder not found: %s', essFolder);
end

pcsFolder = fullfile(baseFolder, 'PCS');
if isfolder(pcsFolder)
    pcsFiles = [dir(fullfile(pcsFolder,'*.xlsx')); dir(fullfile(pcsFolder,'*.xls'))];
    for k = 1:numel(pcsFiles)
        fpath = fullfile(pcsFolder, pcsFiles(k).name);
        key   = mkField(pcsFiles(k).name);
        try,    rawPCS.(key) = readtable(fpath,'PreserveVariableNames',true);
        catch,  rawPCS.(key) = readtable(fpath,'PreserveVariableNames',true,'ReadVariableNames',true); end
    end
else
    warning('PCS folder not found: %s', pcsFolder);
end

if isfolder(smartFolder)
    smartFilesAll = [dir(fullfile(smartFolder,'*.xlsx')); dir(fullfile(smartFolder,'*.xls'))];
    for k = 1:numel(smartFilesAll)
        fpath = fullfile(smartFolder, smartFilesAll(k).name);
        key   = mkField(smartFilesAll(k).name);
        try,    rawSmart.(key) = readtable(fpath,'PreserveVariableNames',true);
        catch,  rawSmart.(key) = readtable(fpath,'PreserveVariableNames',true,'ReadVariableNames',true); end
    end
end

%% =====================================================================
%  ESS EQUIVALENT CYCLE — TODAY  (D_today = avg of last cycle per device)
%% =====================================================================
TTcycle       = timetable('Size',[0 1],'VariableTypes',{'double'}, ...
                          'VariableNames',{'AvgCycles'}, ...
                          'RowTimes',datetime.empty(0,1));
TTallCyc      = [];
dailyCycleAvg = NaN;
totalCycleAvg = NaN;
perDeviceTotal = [];

if isfolder(essFolder)
    essFilesAll = [dir(fullfile(essFolder,'*.xlsx')); dir(fullfile(essFolder,'*.xls'))];
    nESS = numel(essFilesAll);

    for k = 1:nESS
        fpath = fullfile(essFolder, essFilesAll(k).name);
        try
            Tess   = readtable(fpath,'PreserveVariableNames',true,'VariableNamingRule','preserve');
            vnames = string(Tess.Properties.VariableNames);
            vlow   = lower(vnames);

            idxT = find(contains(vlow,"start") & contains(vlow,"time"),1);
            if isempty(idxT), idxT = find(contains(vlow,"time"),1); end
            if isempty(idxT)
                for ci = 1:min(5,width(Tess))
                    try
                        datetime(string(Tess{1,ci}),'InputFormat','yyyy-MM-dd HH:mm:ss');
                        idxT = ci; break;
                    catch, end
                end
            end
            if isempty(idxT), idxT = 4; end

            idxC = find(contains(vlow,"equivalent") & contains(vlow,"cycle"),1);
            if isempty(idxC), idxC = find(contains(vlow,"cycle"),1); end
            if isempty(idxC), idxC = 6; end

            fprintf('  [Cycle] %s | time col=%d | cycle col=%d (%s)\n', ...
                essFilesAll(k).name, idxT, idxC, vnames(idxC));

            rawT  = string(Tess{:,idxT});
            t_ess = NaT(size(rawT));
            for ri = 1:numel(rawT)
                try, t_ess(ri) = datetime(rawT(ri),'InputFormat','yyyy-MM-dd HH:mm:ss'); catch, end
            end

            cyc = Tess{:,idxC};
            if ~isnumeric(cyc), cyc = str2double(string(cyc)); end

            isSummary = ismember(string(Tess{:,1}),["Average","Max","Min"]);
            good = ~isnat(t_ess) & ~isnan(cyc) & ~isSummary;
            t_ess = t_ess(good); cyc = cyc(good);

            if isempty(t_ess)
                warning('[Cycle] %s: no valid rows.', essFilesAll(k).name); continue
            end

            perDeviceTotal(end+1) = cyc(end);  %#ok<AGROW>

            TTk = timetable(t_ess, cyc, 'VariableNames',{sprintf('Cyc%d',k)});
            if isempty(TTallCyc), TTallCyc = TTk;
            else,                 TTallCyc = synchronize(TTallCyc,TTk,'union'); end

            fprintf('  [Cycle] -> %d valid rows | total=%.3f\n', ...
                numel(t_ess), perDeviceTotal(end));

        catch ME
            warning('[Cycle] Failed: %s | %s', essFilesAll(k).name, ME.message);
        end
    end

    if ~isempty(TTallCyc)
        TTallCyc           = fillmissing(TTallCyc,'previous','EndValues','nearest');
        TTallCyc           = fillmissing(TTallCyc,'next');
        TTallCyc.AvgCycles = mean(TTallCyc{:,1:end},2,'omitnan');
        TTcycle            = TTallCyc(:,{'AvgCycles'});
        totalCycleAvg      = mean(perDeviceTotal, 'omitnan');
        fprintf('✅ ESS Today | D_today = %.4f\n', totalCycleAvg);
    else
        warning('No valid ESS cycle data found.');
    end
end

%% =====================================================================
%  ESS EQUIVALENT CYCLE — YESTERDAY  (D_yesterday = avg of last cycle per device)
%% =====================================================================
D_yesterday        = NaN;
perDeviceYesterday = [];

if isfolder(yesterdayESSFolder)
    essFilesYest = [dir(fullfile(yesterdayESSFolder,'*.xlsx')); ...
                    dir(fullfile(yesterdayESSFolder,'*.xls'))];

    for k = 1:numel(essFilesYest)
        fpath = fullfile(yesterdayESSFolder, essFilesYest(k).name);
        try
            Ty   = readtable(fpath,'PreserveVariableNames',true,'VariableNamingRule','preserve');
            vlow = lower(string(Ty.Properties.VariableNames));

            idxC = find(contains(vlow,"equivalent") & contains(vlow,"cycle"),1);
            if isempty(idxC), idxC = find(contains(vlow,"cycle"),1); end
            if isempty(idxC), idxC = 6; end

            cycY = Ty{:,idxC};
            if ~isnumeric(cycY), cycY = str2double(string(cycY)); end
            cycY = cycY(~isnan(cycY));

            if ~isempty(cycY)
                perDeviceYesterday(end+1) = cycY(end);  %#ok<AGROW>
            end
        catch ME
            warning('[Yesterday Cycle] Failed: %s | %s', essFilesYest(k).name, ME.message);
        end
    end

    if ~isempty(perDeviceYesterday)
        D_yesterday = mean(perDeviceYesterday, 'omitnan');
        fprintf('✅ ESS Yesterday | D_yesterday = %.4f\n', D_yesterday);
    end
else
    warning('Yesterday ESS folder not found: %s', yesterdayESSFolder);
end

%% =====================================================================
%  DAILY CYCLE = D_today - D_yesterday
%% =====================================================================
D_today = totalCycleAvg;

if ~isnan(D_today) && ~isnan(D_yesterday)
    dailyCycleAvg = D_today - D_yesterday;
else
    dailyCycleAvg = NaN;
    warning('Cannot compute Daily Cycle. Check ESS folders.');
end

if ~isnan(dailyCycleAvg) && dailyCycleAvg < 0
    warning('Daily Cycle is NEGATIVE — check ESS data!');
end

fprintf('✅ Daily Cycle = D_today(%.4f) - D_yesterday(%.4f) = %.4f\n', ...
    D_today, D_yesterday, dailyCycleAvg);

%% =====================================================================
%  FIGURE — SNTB 30MWh-Power Flow
%% =====================================================================
Vavg = (Vab + Vbc + Vca) / 3;

dayStr    = datestr(t(1),'yyyymmdd');
dateLabel = datestr(t(1),'dd-mmm-yyyy');
outFolder = baseFolder;
if ~isfolder(outFolder), mkdir(outFolder); end
saveFig = @(figH,fname) savefig(figH, fullfile(outFolder,fname));

fig5 = figure('Color','w','Name','SNTB 30MWh-Power Flow');
set(fig5,'Units','normalized','Position',[0.05 0.05 0.9 0.85]);
tiledlayout(3,1,'TileSpacing','compact','Padding','compact');

% ---- Subplot 1 : P & F ----
ax1 = nexttile;
yyaxis left;  hP1=stairs(t,P_MW,'LineWidth',1.4); ylabel('P (MW)'); ylim(Pylim_MW); yticks(Pticks_MW);
yyaxis right; hF =plot(t,F,'LineWidth',1.2);       ylabel('F (Hz)');
grid on; title('Active Power and Frequency')
legend([hP1 hF],{'P (POC) (MW)','F (Hz)'},'Location','northwest')
ax1.XTick=t(1):dtTick:t(end); xtickformat('HH:mm')

% ---- Subplot 2 : P & SOC  +  Cycle label ----
ax2 = nexttile;
yyaxis left
hP2 = plot(t,P_MW,'-','Color',[0 0.4470 0.7410],'LineWidth',1.3);
ylabel('P (MW)'); ylim(Pylim_MW); yticks(Pticks_MW);
yyaxis right
hSOC = plot(t,SOC,'LineWidth',1.2);
ylabel('SOC (%)');
grid on; title('Active Power and SOC')
legend([hP2 hSOC],{'P (POC) (MW)','SOC (%)'},'Location','northwest')
ax2.XTick=t(1):dtTick:t(end); xtickformat('HH:mm')

% ---- Cycle annotation ----
if ~isnan(dailyCycleAvg) && ~isnan(totalCycleAvg)
    lgMain = legend(ax2);
    labelStr = sprintf( ...
        'Daily cycle (%s):\n  Cycle Plant Avg  =  %.3f\n\nTotal cycle:\n  Total Plant Avg  =  %.3f', ...
        dateLabel, dailyCycleAvg, totalCycleAvg);
    text(ax2, 0.99, 0.97, labelStr, ...
        'Units',              'normalized', ...
        'HorizontalAlignment','right', ...
        'VerticalAlignment',  'top', ...
        'FontName',           lgMain.FontName, ...
        'FontSize',           lgMain.FontSize, ...
        'FontWeight',         'normal', ...
        'Color',              [0 0 0], ...
        'BackgroundColor',    lgMain.Color, ...
        'EdgeColor',          lgMain.EdgeColor, ...
        'LineWidth',          lgMain.LineWidth, ...
        'Margin',             4);
end

% ---- Subplot 3 : Vavg & Q ----
ax3 = nexttile;
yyaxis left
hVavg = plot(t,Vavg,'-','LineWidth',0.8,'Color',[0.466 0.674 0.188]);
ylabel('Average Voltage (kV)');
yyaxis right
hQ = stairs(t,Q_MVar,'LineWidth',1.5,'Color',red);
ylabel('Q (MVar)'); ylim(Qylim_Mvar); yticks(Qticks_Mvar);
grid on; title('Reactive Power and Average Voltage')
legend([hQ hVavg],{'Q (POC)','Vavg (kV)'},'Location','northwest')
ax3.XTick=t(1):dtTick:t(end); xtickformat('HH:mm')

sgtitle('SNTB 30MWh-Power Flow','FontSize',14,'FontWeight','bold');

saveFig(fig5, sprintf('%s_SNTB_30MWh_PowerFlow.fig', dayStr));
fprintf('✅ Saved Figure | Daily=%.3f | Total=%.3f\n', dailyCycleAvg, totalCycleAvg);

%% =====================================================================
%  FILE REFERENCES & RAW TABLES
%% =====================================================================
srcFiles             = struct();
srcFiles.baseFolder  = baseFolder;
srcFiles.socfvPath   = socfvPath;
srcFiles.pqPath      = pqPath;
srcFiles.smartFolder = smartFolder;
srcFiles.essFolder   = essFolder;
srcFiles.pcsFolder   = pcsFolder;

SOC_RawData = T1;
POC_RawData = T2;
PVS_RawData = table();

%% =====================================================================
%  SAVE .MAT
%% =====================================================================
matName = sprintf('SNTB_%s_data.mat', dayStr);
matPath = fullfile(baseFolder, matName);

if ~exist('TT5','var') || isempty(TT5)
    TT5 = timetable('Size',[0 2],'VariableTypes',{'double','double'}, ...
                    'VariableNames',{'TotalP_MW','TotalQ_MVar'}, ...
                    'RowTimes',datetime.empty(0,1));
end
if ~exist('TTcycle','var') || isempty(TTcycle)
    TTcycle = timetable('Size',[0 1],'VariableTypes',{'double'}, ...
                        'VariableNames',{'AvgCycles'}, ...
                        'RowTimes',datetime.empty(0,1));
end

save(matPath, ...
    'SOC_RawData','POC_RawData','PVS_RawData', ...
    'rawESS','rawPCS','rawSmart', ...
    'TT','TT5','TTcycle', ...
    'srcFiles', '-v7.3');

fprintf('✅ Saved ALL RAW DATA + TTcycle into:\n   %s\n', matPath);
disp('✅ Done.');