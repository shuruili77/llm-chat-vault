/**
 * Usage Insights & Analytics Dashboard Modal
 */

import { ApiClient } from '../utils/api-client.js';

export class InsightsModal {
    constructor(options = {}) {
        this.onSelectConversation = options.onSelectConversation || null;
        this.overlay = document.getElementById('insights-modal-overlay');
        this.body = document.getElementById('insights-modal-body');
        this.closeBtn = document.getElementById('insights-modal-close');
        this.openBtn = document.getElementById('btn-open-insights');
        this.cutoffSelect = document.getElementById('insights-day-cutoff-select');
        this.currentData = null;
        this.fallbackConversations = [];

        this.initEvents();
    }

    initEvents() {
        if (this.openBtn) {
            this.openBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.open();
            });
        }

        if (this.closeBtn) {
            this.closeBtn.addEventListener('click', () => this.close());
        }

        if (this.overlay) {
            this.overlay.addEventListener('click', (e) => {
                if (e.target === this.overlay) this.close();
            });
        }

        if (this.cutoffSelect) {
            this.cutoffSelect.addEventListener('change', () => {
                const val = this.cutoffSelect.value || '0';
                localStorage.setItem('llm_viewer_insights_cutoff_hour', val);
                this.refreshData();
            });
        }

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen()) {
                this.close();
            }
        });
    }

    isOpen() {
        return this.overlay && this.overlay.style.display === 'flex';
    }

    getSavedCutoffHour() {
        try {
            const saved = localStorage.getItem('llm_viewer_insights_cutoff_hour');
            return saved !== null ? parseInt(saved, 10) : 0;
        } catch {
            return 0;
        }
    }

    async open(fallbackConversations = []) {
        if (!this.overlay || !this.body) return;
        this.fallbackConversations = fallbackConversations || [];
        this.overlay.style.display = 'flex';

        const cutoffHour = this.getSavedCutoffHour();
        if (this.cutoffSelect) {
            this.cutoffSelect.value = String(cutoffHour);
        }

        await this.loadAndRender(cutoffHour);
    }

    async refreshData() {
        const cutoffHour = this.cutoffSelect ? parseInt(this.cutoffSelect.value, 10) : this.getSavedCutoffHour();
        await this.loadAndRender(cutoffHour);
    }

    async loadAndRender(cutoffHour = 0) {
        this.renderLoading();

        try {
            let data;
            try {
                data = await ApiClient.getAnalytics(cutoffHour);
            } catch (err) {
                console.warn('Backend analytics failed, using local calculation:', err);
                data = this.computeLocalAnalytics(this.fallbackConversations, cutoffHour);
            }

            this.currentData = data;
            this.renderDashboard(data);
        } catch (err) {
            console.error('Failed to load analytics:', err);
            this.body.innerHTML = `
                <div class="text-center py-5 text-danger">
                    <p class="mb-2">⚠️ Failed to load usage analytics</p>
                    <small class="text-muted">${this.escapeHtml(err.message)}</small>
                </div>
            `;
        }
    }

    close() {
        if (this.overlay) {
            this.overlay.style.display = 'none';
        }
    }

    renderLoading() {
        this.body.innerHTML = `
            <div class="insights-loading text-center py-5">
                <div class="spinner-border text-primary mb-3" role="status">
                    <span class="visually-hidden">Loading insights...</span>
                </div>
                <h6 class="text-secondary fw-normal">Analyzing your conversation history & usage data...</h6>
            </div>
        `;
    }

    renderDashboard(data) {
        const { overview, top_models, monthly_timeline, longest_conversations, weekly_heatmap } = data;

        const totalAssistantMsgs = overview.assistant_messages || 1;

        // Find top 3 active months
        const topMonths = [...monthly_timeline].sort((a, b) => b.conversation_count - a.conversation_count).slice(0, 3);
        const maxMonthConvs = Math.max(...monthly_timeline.map(m => m.conversation_count), 1);

        this.body.innerHTML = `
            <!-- Overview Stat Cards -->
            <div class="insights-stats-grid mb-4">
                <div class="insight-stat-card">
                    <div class="insight-stat-icon">💬</div>
                    <div class="insight-stat-content">
                        <div class="insight-stat-value">${this.formatNumber(overview.total_conversations)}</div>
                        <div class="insight-stat-label">Total Chats</div>
                    </div>
                </div>
                <div class="insight-stat-card">
                    <div class="insight-stat-icon">✉️</div>
                    <div class="insight-stat-content">
                        <div class="insight-stat-value">${this.formatNumber(overview.total_messages)}</div>
                        <div class="insight-stat-label">Total Messages</div>
                    </div>
                </div>
                <div class="insight-stat-card" title="${this.formatNumber(overview.assistant_characters)} characters across ${this.formatNumber(overview.assistant_messages)} AI responses">
                    <div class="insight-stat-icon">🤖</div>
                    <div class="insight-stat-content">
                        <div class="insight-stat-value">${this.formatCharsHtml(overview.assistant_characters)}</div>
                        <div class="insight-stat-label">AI Generated</div>
                    </div>
                </div>
                <div class="insight-stat-card" title="${this.formatNumber(overview.user_characters)} characters across ${this.formatNumber(overview.user_messages)} user prompts">
                    <div class="insight-stat-icon">✍️</div>
                    <div class="insight-stat-content">
                        <div class="insight-stat-value">${this.formatCharsHtml(overview.user_characters)}</div>
                        <div class="insight-stat-label">Your Prompts</div>
                    </div>
                </div>
                <div class="insight-stat-card">
                    <div class="insight-stat-icon">⭐</div>
                    <div class="insight-stat-content">
                        <div class="insight-stat-value text-warning">${this.formatNumber(overview.starred_conversations)}</div>
                        <div class="insight-stat-label">Starred Favorites</div>
                    </div>
                </div>
            </div>

            <!-- Main Layout Grid -->
            <div class="insights-grid-2col">
                <!-- Left Column: Top Models Leaderboard & Habits -->
                <div class="insights-col">
                    <!-- Top Models Leaderboard -->
                    <div class="insights-section-card mb-4">
                        <div class="insights-section-header">
                            <h6 class="insights-section-title">
                                <span class="me-2">🏆</span>AI Model Leaderboard
                            </h6>
                            <span class="insights-section-badge">${top_models.length} Models</span>
                        </div>
                        <div class="insights-models-list">
                            ${top_models.map((m, idx) => {
                                const rank = idx + 1;
                                const rankClass = rank === 1 ? 'rank-1' : (rank === 2 ? 'rank-2' : (rank === 3 ? 'rank-3' : ''));
                                const rankBadge = rank === 1 ? '🥇' : (rank === 2 ? '🥈' : (rank === 3 ? '🥉' : `#${rank}`));
                                const displayName = this.formatModelName(m.model);
                                const pct = ((m.message_count / totalAssistantMsgs) * 100).toFixed(1);
                                return `
                                    <div class="model-leaderboard-item">
                                        <div class="model-item-top">
                                            <div class="model-item-name-wrap">
                                                <span class="model-rank-badge ${rankClass}">${rankBadge}</span>
                                                <span class="model-item-name" title="${this.escapeHtml(m.model)}">${this.escapeHtml(displayName)}</span>
                                            </div>
                                            <div class="model-item-meta">
                                                <span class="model-msg-count">${this.formatNumber(m.message_count)} msgs</span>
                                                <span class="model-conv-count text-muted">(${this.formatNumber(m.conversation_count)} chats • ${pct}%)</span>
                                            </div>
                                        </div>
                                        <div class="model-progress-bg">
                                            <div class="model-progress-fill ${rankClass}" style="width: ${pct}%;"></div>
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>

                    <!-- Weekly 7 Days x 24 Hours Activity Heatmap & Daily Breakdown -->
                    <div class="insights-section-card">
                        <div class="insights-section-header">
                            <h6 class="insights-section-title">
                                <span class="me-2">🗓️</span>Weekly Activity & Heatmap
                            </h6>
                            <span class="insights-section-badge">7 Days × 24h</span>
                        </div>
                        <div class="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-1">
                            <span class="insights-hint-text mb-0">Frequency of your prompts across every day and hour.</span>
                            ${data.weekly_heatmap && data.weekly_heatmap.peak_cell && data.weekly_heatmap.peak_cell.count > 0 ? `
                                <span class="heatmap-peak-badge" title="Most active single time slot">
                                    🔥 Peak: ${data.weekly_heatmap.peak_cell.day} ${String(data.weekly_heatmap.peak_cell.hour).padStart(2, '0')}:00 (${this.formatNumber(data.weekly_heatmap.peak_cell.count)} prompts)
                                </span>
                            ` : ''}
                        </div>

                        <div class="heatmap-wrapper mt-2">
                            <!-- Heatmap Hours Ticks Header -->
                            <div class="heatmap-header-row">
                                <div class="heatmap-day-spacer"></div>
                                <div class="heatmap-hours-ticks">
                                    <span class="heat-hour-tick">00</span>
                                    <span class="heat-hour-tick">03</span>
                                    <span class="heat-hour-tick">06</span>
                                    <span class="heat-hour-tick">09</span>
                                    <span class="heat-hour-tick">12</span>
                                    <span class="heat-hour-tick">15</span>
                                    <span class="heat-hour-tick">18</span>
                                    <span class="heat-hour-tick">21</span>
                                    <span class="heat-hour-tick">23</span>
                                </div>
                            </div>

                            <!-- Heatmap 7 Rows -->
                            <div class="heatmap-body">
                                ${(data.weekly_heatmap?.days || []).map(d => {
                                    const maxCount = data.weekly_heatmap?.max_count || 1;
                                    return `
                                        <div class="heatmap-row">
                                            <span class="heatmap-day-label">${d.day}</span>
                                            <div class="heatmap-row-cells">
                                                ${d.hours.map(h => {
                                                    const cnt = h.count;
                                                    let level = 0;
                                                    if (cnt > 0) {
                                                        const ratio = maxCount > 0 ? cnt / maxCount : 0;
                                                        if (ratio > 0.70) level = 4;
                                                        else if (ratio > 0.40) level = 3;
                                                        else if (ratio > 0.15) level = 2;
                                                        else level = 1;
                                                    }
                                                    const isPeak = cnt === maxCount && cnt > 0;
                                                    const nextHour = (h.hour + 1) % 24;
                                                    const tooltip = `${d.day} ${String(h.hour).padStart(2, '0')}:00 - ${String(nextHour).padStart(2, '0')}:00 • ${this.formatNumber(cnt)} prompts`;
                                                    return `<div class="heatmap-cell heat-level-${level} ${isPeak ? 'heat-cell-peak' : ''}" data-count="${cnt}" title="${this.escapeHtml(tooltip)}"></div>`;
                                                }).join('')}
                                            </div>
                                        </div>
                                    `;
                                }).join('')}
                            </div>

                            <!-- Heatmap Footer Legend -->
                            <div class="heatmap-footer mt-2 pt-2 border-top border-secondary-subtle">
                                <span class="heatmap-summary-text text-muted small">168 time slots</span>
                                <div class="heatmap-legend-wrap">
                                    <span class="heatmap-legend-label">Less</span>
                                    <div class="heatmap-legend-cells">
                                        <span class="heatmap-cell heat-level-0" title="0 prompts"></span>
                                        <span class="heatmap-cell heat-level-1" title="Low activity"></span>
                                        <span class="heatmap-cell heat-level-2" title="Medium activity"></span>
                                        <span class="heatmap-cell heat-level-3" title="High activity"></span>
                                        <span class="heatmap-cell heat-level-4" title="Peak activity"></span>
                                    </div>
                                    <span class="heatmap-legend-label">More</span>
                                </div>
                            </div>
                        </div>

                        <!-- Daily Volume Breakdown (Monday - Sunday) -->
                        <div class="dow-breakdown-section mt-3 pt-3 border-top border-secondary-subtle">
                            <div class="d-flex justify-content-between align-items-center mb-2">
                                <span class="small fw-semibold text-secondary">📊 Daily Breakdown (Mon – Sun)</span>
                            </div>
                            <div class="dow-grid">
                                ${(data.weekly_heatmap?.days || []).map(d => {
                                    const totalWeekly = data.weekly_heatmap?.total_weekly_convs || 1;
                                    const pct = ((d.conv_count / totalWeekly) * 100).toFixed(1);
                                    const maxDayConvs = Math.max(...(data.weekly_heatmap?.days || []).map(x => x.conv_count), 1);
                                    const barHeightPct = ((d.conv_count / maxDayConvs) * 100).toFixed(0);
                                    return `
                                        <div class="dow-item" title="${d.day}: ${this.formatNumber(d.conv_count)} chats (${pct}%), ${this.formatNumber(d.total)} prompts">
                                            <span class="dow-label">${d.day}</span>
                                            <div class="dow-progress-track">
                                                <div class="dow-progress-fill" style="width: ${barHeightPct}%;"></div>
                                            </div>
                                            <span class="dow-count">${this.formatNumber(d.conv_count)}</span>
                                            <span class="dow-sub-count text-muted">${pct}%</span>
                                        </div>
                                    `;
                                }).join('')}
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Right Column: Monthly Activity & Longest Chats -->
                <div class="insights-col">
                    <!-- Top Active Months -->
                    <div class="insights-section-card mb-4">
                        <div class="insights-section-header">
                            <h6 class="insights-section-title">
                                <span class="me-2">📅</span>Monthly Activity & Trends
                            </h6>
                            <span class="insights-section-badge">${monthly_timeline.length} Months Tracked</span>
                        </div>

                        <!-- Top 3 highlights -->
                        <div class="top-months-grid mb-3">
                            ${topMonths.map((m, idx) => `
                                <div class="top-month-card">
                                    <div class="top-month-rank">${idx === 0 ? '🥇 1st' : (idx === 1 ? '🥈 2nd' : '🥉 3rd')}</div>
                                    <div class="top-month-name">${m.month}</div>
                                    <div class="top-month-stats">
                                        <span class="fw-bold">${this.formatNumber(m.conversation_count)}</span> chats
                                        <span class="text-muted">(${this.formatNumber(m.total_messages)} msgs)</span>
                                    </div>
                                </div>
                            `).join('')}
                        </div>

                        <!-- Monthly Timeline Scrollable Bar List -->
                        <div class="monthly-timeline-scroll">
                            ${[...monthly_timeline].reverse().map(m => {
                                const pct = maxMonthConvs > 0 ? ((m.conversation_count / maxMonthConvs) * 100).toFixed(0) : 0;
                                return `
                                    <div class="monthly-row-item">
                                        <span class="month-row-label">${m.month}</span>
                                        <div class="month-row-bar-track">
                                            <div class="month-row-bar-fill" style="width: ${pct}%;"></div>
                                        </div>
                                        <span class="month-row-count">${m.conversation_count} chats</span>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>

                    <!-- Longest & Deepest Conversations -->
                    <div class="insights-section-card">
                        <div class="insights-section-header">
                            <h6 class="insights-section-title">
                                <span class="me-2">📜</span>Top Longest & Deepest Chats
                            </h6>
                            <span class="insights-section-badge">Top 15</span>
                        </div>
                        <p class="insights-hint-text">Click any conversation to open it directly in the viewer.</p>
                        <div class="longest-chats-list">
                            ${longest_conversations.map((c, idx) => {
                                const rank = idx + 1;
                                const rankBadge = rank === 1 ? '🥇' : (rank === 2 ? '🥈' : (rank === 3 ? '🥉' : `#${rank}`));
                                const rankClass = rank <= 3 ? `rank-${rank}` : '';
                                const dateStr = c.created_at ? new Date(c.created_at * 1000).toLocaleDateString() : '';
                                const modelBadge = c.model_slug ? `<span class="longest-model-pill">${this.escapeHtml(this.formatModelName(c.model_slug))}</span>` : '';
                                return `
                                    <div class="longest-chat-card" data-conv-id="${c.id}" title="Click to view conversation">
                                        <span class="longest-chat-rank ${rankClass}">${rankBadge}</span>
                                        <div class="longest-chat-info">
                                            <div class="longest-chat-title-row">
                                                <h6 class="longest-chat-title">${this.escapeHtml(c.display_title)}</h6>
                                                ${c.is_starred ? '<span class="text-warning small" title="Starred">⭐</span>' : ''}
                                            </div>
                                            <div class="longest-chat-meta">
                                                <span class="longest-msg-badge">${this.formatNumber(c.message_count)} messages</span>
                                                ${modelBadge}
                                                <span class="longest-date text-muted">${dateStr}</span>
                                            </div>
                                        </div>
                                        <div class="longest-chat-arrow">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 16 16">
                                                <path fill-rule="evenodd" d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z"/>
                                            </svg>
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                </div>
            </div>
        `;

        // Attach click handlers to longest chat items
        this.body.querySelectorAll('.longest-chat-card').forEach(card => {
            card.addEventListener('click', () => {
                const convId = card.dataset.convId;
                if (convId && this.onSelectConversation) {
                    this.close();
                    this.onSelectConversation(convId);
                }
            });
        });
    }

    computeLocalAnalytics(conversations = [], cutoffHour = 0) {
        let totalMsgs = 0;
        let userMsgs = 0;
        let asstMsgs = 0;
        let userChars = 0;
        let asstChars = 0;
        let starredCount = 0;
        const modelMap = {};
        const monthMap = {};
        const cutoffMs = (cutoffHour || 0) * 3600 * 1000;

        conversations.forEach(c => {
            const msgs = c.active_branch || c.messages || [];
            totalMsgs += msgs.length;
            if (c.is_starred) starredCount++;

            const rawCreated = c.created ? new Date(c.created) : (c.created_at ? new Date(c.created_at * 1000) : null);
            if (rawCreated && !isNaN(rawCreated.getTime())) {
                const shiftedDate = new Date(rawCreated.getTime() - cutoffMs);
                const monthKey = `${shiftedDate.getFullYear()}-${String(shiftedDate.getMonth() + 1).padStart(2, '0')}`;
                if (!monthMap[monthKey]) {
                    monthMap[monthKey] = { month: monthKey, conversation_count: 0, total_messages: 0 };
                }
                monthMap[monthKey].conversation_count++;
                monthMap[monthKey].total_messages += msgs.length;
            }

            msgs.forEach(m => {
                const isUser = m.role === 'user';
                const isAsst = m.role === 'assistant';
                const len = (m.content || '').length;

                if (isUser) {
                    userMsgs++;
                    userChars += len;
                } else if (isAsst) {
                    asstMsgs++;
                    asstChars += len;
                    const model = m.model_slug || m.metadata?.model_slug || m.metadata?.model || c.model_slug || 'Unknown';
                    if (!modelMap[model]) {
                        modelMap[model] = { model, message_count: 0, conv_ids: new Set() };
                    }
                    modelMap[model].message_count++;
                    modelMap[model].conv_ids.add(c.id);
                }
            });
        });

        const topModels = Object.values(modelMap).map(m => ({
            model: m.model,
            message_count: m.message_count,
            conversation_count: m.conv_ids.size
        })).sort((a, b) => b.message_count - a.message_count).slice(0, 15);

        const monthlyTimeline = Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month));

        const longestConversations = [...conversations].sort((a, b) => {
            const countA = a.message_count ?? (a.messages || []).length;
            const countB = b.message_count ?? (b.messages || []).length;
            return countB - countA;
        }).slice(0, 15).map(c => ({
            id: c.id,
            title: c.title || 'Untitled',
            custom_title: c.custom_title || null,
            display_title: c.custom_title || c.title || 'Untitled',
            message_count: c.message_count ?? (c.messages || []).length,
            created_at: c.created ? new Date(c.created).getTime() / 1000 : (c.created_at || 0),
            model_slug: c.model_slug || null,
            is_starred: Boolean(c.is_starred)
        }));

        // 7x24 heatmap computation
        const daysOrder = [
            { dow: 1, name: "Mon" },
            { dow: 2, name: "Tue" },
            { dow: 3, name: "Wed" },
            { dow: 4, name: "Thu" },
            { dow: 5, name: "Fri" },
            { dow: 6, name: "Sat" },
            { dow: 0, name: "Sun" }
        ];

        const heatCellMap = {};
        const convDowMap = {};
        let maxHeat = 0;
        let peakCell = { day: "N/A", hour: 0, count: 0 };
        let totalWeeklyPrompts = 0;
        let totalWeeklyConvs = 0;

        conversations.forEach(c => {
            const rawCreated = c.created ? new Date(c.created) : (c.created_at ? new Date(c.created_at * 1000) : null);
            if (rawCreated && !isNaN(rawCreated.getTime())) {
                const shiftedDate = new Date(rawCreated.getTime() - cutoffMs);
                const dow = shiftedDate.getDay();
                convDowMap[dow] = (convDowMap[dow] || 0) + 1;
            }

            const msgs = c.active_branch || c.messages || [];
            msgs.forEach(m => {
                if (m.role === 'user') {
                    const rawMDate = m.timestamp ? new Date(m.timestamp) : (m.created_at ? new Date(m.created_at * 1000) : null);
                    if (rawMDate && !isNaN(rawMDate.getTime())) {
                        const shiftedMDate = new Date(rawMDate.getTime() - cutoffMs);
                        const dow = shiftedMDate.getDay();
                        const hr = rawMDate.getHours();
                        const k = `${dow}_${hr}`;
                        heatCellMap[k] = (heatCellMap[k] || 0) + 1;
                        if (heatCellMap[k] > maxHeat) {
                            maxHeat = heatCellMap[k];
                        }
                    }
                }
            });
        });

        const weeklyHeatmap = daysOrder.map(({ dow, name }) => {
            const dayHours = [];
            let dayTotal = 0;
            for (let h = 0; h < 24; h++) {
                const c = heatCellMap[`${dow}_${h}`] || 0;
                dayHours.push({ hour: h, count: c });
                dayTotal += c;
                if (c === maxHeat && c > 0) {
                    peakCell = { day: name, hour: h, count: c };
                }
            }
            const dayConvs = convDowMap[dow] || 0;
            totalWeeklyPrompts += dayTotal;
            totalWeeklyConvs += dayConvs;

            return {
                dow_index: dow,
                day: name,
                total: dayTotal,
                conv_count: dayConvs,
                hours: dayHours
            };
        });

        const avgDailyConvs = totalWeeklyConvs > 0 ? Math.round((totalWeeklyConvs / 7.0) * 10) / 10 : 0;
        const avgDailyPrompts = totalWeeklyPrompts > 0 ? Math.round((totalWeeklyPrompts / 7.0) * 10) / 10 : 0;

        return {
            overview: {
                total_conversations: conversations.length,
                total_messages: totalMsgs,
                assistant_messages: asstMsgs,
                user_messages: userMsgs,
                assistant_characters: asstChars,
                user_characters: userChars,
                starred_conversations: starredCount
            },
            cutoff_hour: cutoffHour,
            top_models: topModels,
            monthly_timeline: monthlyTimeline,
            longest_conversations: longestConversations,
            weekly_heatmap: {
                days: weeklyHeatmap,
                max_count: maxHeat,
                peak_cell: peakCell,
                total_weekly_convs: totalWeeklyConvs,
                total_weekly_prompts: totalWeeklyPrompts,
                avg_daily_convs: avgDailyConvs,
                avg_daily_prompts: avgDailyPrompts
            }
        };
    }

    formatNumber(num) {
        if (num === null || num === undefined) return '0';
        return Number(num).toLocaleString();
    }

    formatShortNumber(num) {
        if (!num || num === 0) return '0';
        if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
        if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
        return Number(num).toLocaleString();
    }

    formatCharsHtml(chars) {
        if (!chars || chars === 0) return `0 <span class="insight-stat-unit">chars</span>`;
        if (chars >= 1000000) {
            return `${(chars / 1000000).toFixed(1)}M <span class="insight-stat-unit">chars</span>`;
        }
        if (chars >= 1000) {
            return `${(chars / 1000).toFixed(1)}K <span class="insight-stat-unit">chars</span>`;
        }
        return `${chars} <span class="insight-stat-unit">chars</span>`;
    }

    formatChars(chars) {
        if (!chars || chars === 0) return '0 chars';
        if (chars >= 1000000) {
            return `${(chars / 1000000).toFixed(1)}M chars`;
        }
        if (chars >= 1000) {
            return `${(chars / 1000).toFixed(1)}K chars`;
        }
        return `${chars} chars`;
    }

    formatModelName(slug) {
        if (!slug || typeof slug !== 'string') return 'Unknown';
        const s = slug.trim();
        if (!s) return 'Unknown';
        const lower = s.toLowerCase();

        if (lower === 'gpt-4o') return 'GPT-4o';
        if (lower === 'gpt-4o-mini') return 'GPT-4o Mini';
        if (lower === 'gpt-4o-canmore') return 'GPT-4o (Canvas)';
        if (lower === 'gpt-4o-av') return 'GPT-4o (Voice)';
        if (lower === 'gpt-4-turbo' || lower.includes('gpt-4-turbo')) return 'GPT-4 Turbo';
        if (lower === 'gpt-4-gizmo') return 'GPT-4 (Custom GPT)';
        if (lower === 'gpt-4-plugins') return 'GPT-4 (Plugins)';
        if (lower === 'gpt-4-dalle') return 'GPT-4 (DALL·E)';
        if (lower === 'gpt-4-code-interpreter') return 'GPT-4 (Code Interpreter)';
        if (lower === 'gpt-4-browsing') return 'GPT-4 (Browsing)';
        if (lower === 'gpt-4') return 'GPT-4';
        if (lower === 'gpt-4-1' || lower === 'gpt-4.1') return 'GPT-4.1';
        if (lower === 'gpt-4-1-mini') return 'GPT-4.1 Mini';
        if (lower === 'gpt-4-5' || lower === 'gpt-4.5') return 'GPT-4.5';
        if (lower === 'gpt-3.5-turbo' || lower.includes('gpt-3.5')) return 'GPT-3.5 Turbo';
        if (lower.startsWith('text-davinci-002-render') || lower.startsWith('text-davinci-003')) return 'GPT-3.5';

        if (lower === 'o3') return 'o3';
        if (lower === 'o3-mini') return 'o3-mini';
        if (lower === 'o3-mini-high') return 'o3-mini (High)';
        if (lower === 'o1') return 'o1';
        if (lower === 'o1-preview') return 'o1-preview';
        if (lower === 'o1-mini') return 'o1-mini';
        if (lower === 'o4-mini' || lower === 'o4-mini-high') return 'o4-mini (High)';

        if (lower === 'research' || lower === 'deep-research') return 'Deep Research';
        if (lower === 'auto') return 'Auto Model';

        if (lower.startsWith('gpt-5')) {
            let name = s.replace(/^gpt-/i, 'GPT-').replace(/-/g, ' ');
            name = name.replace(/GPT 5 (\d)/i, 'GPT-5.$1')
                       .replace(/GPT 5\b/i, 'GPT-5')
                       .replace(/thinking/i, 'Thinking')
                       .replace(/instant/i, 'Instant')
                       .replace(/auto/i, 'Auto');
            return name;
        }

        if (lower.includes('claude-3-5-sonnet') || lower.includes('claude-3.5-sonnet')) return 'Claude 3.5 Sonnet';
        if (lower.includes('claude-3-5-haiku') || lower.includes('claude-3.5-haiku')) return 'Claude 3.5 Haiku';
        if (lower.includes('claude-3-opus') || lower.includes('claude-3.0-opus')) return 'Claude 3 Opus';
        if (lower.includes('claude-3-sonnet')) return 'Claude 3 Sonnet';
        if (lower.includes('claude-3-haiku')) return 'Claude 3 Haiku';
        if (lower.includes('claude-2')) return 'Claude 2';
        if (lower === 'claude') return 'Claude';
        if (lower.startsWith('claude')) {
            return s.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        }

        if (lower === 'zai' || lower === 'z.ai') return 'Z.ai';
        if (lower.startsWith('gpt-')) return s.replace(/^gpt-/i, 'GPT-');

        return s;
    }

    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}
