/*******************************************************************************

    httpswitchboard - a Chromium browser extension to black/white list requests.
    Copyright (C) 2013  Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/httpswitchboard
*/

/* global chrome, HTTPSB */

/******************************************************************************/

// Create a new page url stats store (if not already present)

HTTPSB.createPageStats = function(pageUrl) {
    // https://github.com/gorhill/httpswitchboard/issues/303
    // At this point, the URL has been page-URL-normalized

    // do not create stats store for urls which are of no interest
    if ( pageUrl.search(/^https?:\/\//) !== 0 ) {
        return undefined;
    }
    var pageStats = this.pageStats[pageUrl];
    if ( !pageStats ) {
        pageStats = this.PageStore.factory(pageUrl);
        // These counters are used so that icon presents an overview of how
        // much allowed/blocked.
        pageStats.perLoadAllowedRequestCount =
        pageStats.perLoadBlockedRequestCount = 0;
        this.pageStats[pageUrl] = pageStats;
    } else if ( pageStats.pageUrl !== pageUrl ) {
        pageStats.init(pageUrl);
    }

    return pageStats;
};

/******************************************************************************/

// https://github.com/gorhill/httpswitchboard/issues/303
// Some kind of trick going on here:
//   Any scheme other than 'http' and 'https' is remapped into a fake
//   URL which trick the rest of HTTPSB into being able to process an
//   otherwise unmanageable scheme. HTTPSB needs web page to have a proper
//   hostname to work properly, so just like the 'chromium-behind-the-scene'
//   fake domain name, we map unknown schemes into a fake '{scheme}-scheme'
//   hostname. This way, for a specific scheme you can create scope with
//   rules which will apply only to that scheme.

HTTPSB.normalizePageURL = function(pageURL) {
    var uri = this.URI.set(pageURL);
    if ( uri.scheme === 'https' || uri.scheme === 'http' ) {
        return uri.normalizedURI();
    }
    // If it is a scheme-based page URL, it is important it is crafted as a
    // normalized URL just like above.
    if ( uri.scheme !== '' ) {
        return 'http://' + uri.scheme + '-scheme/';
    }
    return '';
}

/******************************************************************************/

// Create an entry for the tab if it doesn't exist

HTTPSB.bindTabToPageStats = function(tabId, pageURL) {
    // https://github.com/gorhill/httpswitchboard/issues/303
    // Don't rebind pages blocked by HTTPSB.
    var blockedRootFramePrefix = this.webRequest.blockedRootFramePrefix;
    if ( pageURL.slice(0, blockedRootFramePrefix.length) === blockedRootFramePrefix ) {
        return null;
    }

    // https://github.com/gorhill/httpswitchboard/issues/303
    // Normalize to a page-URL.
    pageURL = this.normalizePageURL(pageURL);

    var pageStats = this.createPageStats(pageURL);

    // console.debug('HTTP Switchboard> HTTPSB.bindTabToPageStats(): dispatching traffic in tab id %d to url stats store "%s"', tabId, pageUrl);

    // rhill 2013-11-24: Never ever rebind chromium-behind-the-scene
    // virtual tab.
    // https://github.com/gorhill/httpswitchboard/issues/67
    if ( tabId === this.behindTheSceneTabId ) {
        return pageStats;
    }

    this.unbindTabFromPageStats(tabId);

    // rhill 2014-02-08: Do not create an entry if no page store
    // exists (like when visiting about:blank)
    // https://github.com/gorhill/httpswitchboard/issues/186
    if ( !pageStats ) {
        return null;
    }
    pageStats.visible = true;

    this.pageUrlToTabId[pageURL] = tabId;
    this.tabIdToPageUrl[tabId] = pageURL;

    return pageStats;
};

HTTPSB.unbindTabFromPageStats = function(tabId) {
    var pageUrl = this.tabIdToPageUrl[tabId];
    if ( pageUrl ) {
        delete this.pageUrlToTabId[pageUrl];
    }
    delete this.tabIdToPageUrl[tabId];
};

/******************************************************************************/

// Log a request

HTTPSB.recordFromTabId = function(tabId, type, url, blocked) {
    var pageStats = this.pageStatsFromTabId(tabId);
    if ( pageStats ) {
        pageStats.recordRequest(type, url, blocked);
    }
};

HTTPSB.recordFromPageUrl = function(pageUrl, type, url, blocked, reason) {
    var pageStats = this.pageStatsFromPageUrl(pageUrl);
    if ( pageStats ) {
        pageStats.recordRequest(type, url, blocked, reason);
    }
};

/******************************************************************************/

HTTPSB.onPageLoadCompleted = function(pageURL) {
    var pageStats = this.pageStatsFromPageUrl(pageURL);
    if ( !pageStats ) {
        return;
    }

    // https://github.com/gorhill/httpswitchboard/issues/181
    if ( pageStats.thirdpartyScript ) {
        pageStats.recordRequest('script', pageURL + '{3rd-party_scripts}', pageStats.pageScriptBlocked);
    }
};

/******************************************************************************/

// Reload content of a tabs.

HTTPSB.smartReloadTabs = function(which, tabId) {
    if ( which === 'none' ) {
        return;
    }

    if ( which === 'current' && typeof tabId === 'number' ) {
        this.smartReloadTab(tabId);
        return;
    }

    // which === 'all'
    var reloadTabs = function(chromeTabs) {
        var httpsb = HTTPSB;
        var tabId;
        var i = chromeTabs.length;
        while ( i-- ) {
            tabId = chromeTabs[i].id;
            if ( httpsb.tabExists(tabId) ) {
                httpsb.smartReloadTab(tabId);
            }
        }
    };

    var getTabs = function() {
        chrome.tabs.query({ status: 'complete' }, reloadTabs);
    };

    this.asyncJobs.add('smartReloadTabs', null, getTabs, 500);
};

/******************************************************************************/

// Reload content of a tab

HTTPSB.smartReloadTab = function(tabId) {
    var pageStats = this.pageStatsFromTabId(tabId);
    if ( !pageStats ) {
        //console.error('HTTP Switchboard> HTTPSB.smartReloadTab(): page stats for tab id %d not found', tabId);
        return;
    }

    // rhill 2013-12-23: Reload only if something previously blocked is now
    // unblocked.
    var blockRule;
    var oldState = pageStats.state;
    var newState = this.computeTabState(tabId);
    var mustReload = false;
    for ( blockRule in oldState ) {
        if ( !oldState.hasOwnProperty(blockRule) ) {
            continue;
        }
        // General rule, reload...
        // If something previously blocked is no longer blocked.
        if ( !newState[blockRule] ) {
            // console.debug('HTTP Switchboard> HTTPSB.smartReloadTab(): will reload because "%s" is no longer blocked', blockRule);
            mustReload = true;
            break;
        }
    }
    // Exceptions: blocking these previously unblocked types must result in a
    // reload:
    // - a script
    // - a frame
    // Related issues:
    // https://github.com/gorhill/httpswitchboard/issues/94
    // https://github.com/gorhill/httpswitchboard/issues/141
    if ( !mustReload ) {
        var reloadNewlyBlockedTypes = {
            'main_frame': true,
            'script' : true,
            'sub_frame': true
        };
        var blockRuleType;
        for ( blockRule in newState ) {
            if ( !newState.hasOwnProperty(blockRule) ) {
                continue;
            }
            blockRuleType = blockRule.slice(0, blockRule.indexOf('|'));
            if ( !reloadNewlyBlockedTypes[blockRuleType] ) {
                continue;
            }
            if ( !oldState[blockRule] ) {
                // console.debug('HTTP Switchboard> HTTPSB.smartReloadTab(): will reload because "%s" is now blocked', blockRule);
                mustReload = true;
                break;
            }
        }
    }

    // console.log('old state: %o\nnew state: %o', oldState, newState);
    
    if ( mustReload ) {
        chrome.tabs.reload(tabId);
    }
    // pageStats.state = newState;
};

/******************************************************************************/

// Required since not all tabs are of interests to HTTP Switchboard.
// Examples:
//      `chrome://extensions/`
//      `chrome-devtools://devtools/devtools.html`
//      etc.

HTTPSB.tabExists = function(tabId) {
    return !!this.pageUrlFromTabId(tabId);
};

/******************************************************************************/

HTTPSB.computeTabState = function(tabId) {
    var pageStats = this.pageStatsFromTabId(tabId);
    if ( !pageStats ) {
        //console.error('HTTP Switchboard> HTTPSB.computeTabState(): page stats for tab id %d not found', tabId);
        return {};
    }
    // Go through all recorded requests, apply filters to create state
    // It is a critical error for a tab to not be defined here
    var pageURL = pageStats.pageUrl;
    var scopeKey = this.temporaryScopeKeyFromPageURL(pageURL);
    var requestDict = pageStats.requests.getRequestDict();
    var computedState = {};
    var hostname, type;
    for ( var reqKey in requestDict ) {
        if ( !requestDict.hasOwnProperty(reqKey) ) {
            continue;
        }

        // The evaluation code here needs to reflect the evaluation code in
        // beforeRequestHandler()
        hostname = this.PageRequestStats.hostnameFromRequestKey(reqKey);

        // rhill 2013-12-10: mind how stylesheets are to be evaluated:
        // `stylesheet` or `other`? Depends of domain of request.
        // https://github.com/gorhill/httpswitchboard/issues/85
        type = this.PageRequestStats.typeFromRequestKey(reqKey);
        if ( this.blacklistedFromScopeKey(scopeKey, type, hostname) ) {
            computedState[type +  '|' + hostname] = true;
        }
    }
    return computedState;
};

/******************************************************************************/

HTTPSB.tabIdFromPageUrl = function(pageURL) {
    // https://github.com/gorhill/httpswitchboard/issues/303
    // Normalize to a page-URL.
    return this.pageUrlToTabId[this.normalizePageURL(pageURL)];
};

HTTPSB.tabIdFromPageStats = function(pageStats) {
    return this.tabIdFromPageUrl(pageStats.pageUrl);
};

HTTPSB.pageUrlFromTabId = function(tabId) {
    return this.tabIdToPageUrl[tabId];
};

HTTPSB.pageUrlFromPageStats = function(pageStats) {
    if ( pageStats ) {
        return pageStats.pageUrl;
    }
    return undefined;
};

HTTPSB.pageStatsFromTabId = function(tabId) {
    var pageUrl = this.tabIdToPageUrl[tabId];
    if ( pageUrl ) {
        return this.pageStats[pageUrl];
    }
    return undefined;
};

HTTPSB.pageStatsFromPageUrl = function(pageURL) {
    if ( pageURL ) {
        return this.pageStats[this.normalizePageURL(pageURL)];
    }
    return null;
};

/******************************************************************************/

HTTPSB.forceReload = function(pageURL) {
    var tabId = this.tabIdFromPageUrl(pageURL);
    if ( tabId ) {
        chrome.tabs.reload(tabId, { bypassCache: true });
    }
};

/******************************************************************************/

// Garbage collect stale url stats entries
(function() {
    var gcOrphanPageStats = function(tabs) {
        var httpsb = HTTPSB;
        var visibleTabs = {};
        tabs.map(function(tab) {
            visibleTabs[tab.id] = true;
        });
        var pageUrls = Object.keys(httpsb.pageStats);
        var i = pageUrls.length;
        var pageUrl, tabId, pageStats;
        while ( i-- ) {
            pageUrl = pageUrls[i];
            // Do not dispose of chromium-behind-the-scene virtual tab,
            // GC is done differently on this one (i.e. just pruning).
            if ( pageUrl === httpsb.behindTheSceneURL ) {
                continue;
            }
            tabId = httpsb.tabIdFromPageUrl(pageUrl);
            pageStats = httpsb.pageStats[pageUrl];
            if ( !visibleTabs[tabId] && !pageStats.visible ) {
                // console.debug('HTTP Switchboard> tab.js: page stats garbage collector letting go of "%s"', pageUrl);
                httpsb.cookieHunter.removePageCookies(pageStats);
                httpsb.pageStats[pageUrl].dispose();
                delete httpsb.pageStats[pageUrl];
            }
            pageStats.visible = !!visibleTabs[tabId];
            if ( !pageStats.visible ) {
                httpsb.unbindTabFromPageStats(tabId);
            }
        }
    };

    var gcPageStats = function() {
        var httpsb = HTTPSB;

        // Get rid of stale pageStats, those not bound to a tab for more than
        // {duration placeholder}.
        chrome.tabs.query({ 'url': '<all_urls>' }, gcOrphanPageStats);

        // Prune content of chromium-behind-the-scene virtual tab
        // When `suggest-as-you-type` is on in Chromium, this can lead to a
        // LOT of uninteresting behind the scene requests.
        var pageStats = httpsb.pageStats[httpsb.behindTheSceneURL];
        if ( pageStats ) {
            var reqKeys = pageStats.requests.getRequestKeys();
            if ( reqKeys.length > httpsb.behindTheSceneMaxReq ) {
                reqKeys = reqKeys.sort(function(a,b){
                    return pageStats.requests[b] - pageStats.requests[a];
                }).slice(httpsb.behindTheSceneMaxReq);
                var iReqKey = reqKeys.length;
                while ( iReqKey-- ) {
                    pageStats.requests.disposeOne(reqKeys[iReqKey]);
                }
            }
        }
    };

    // Time somewhat arbitrary: If a web page has not been in a tab
    // for some time minutes, flush its stats.
    HTTPSB.asyncJobs.add(
        'gcPageStats',
        null,
        gcPageStats,
        8 * 60 * 1000,
        true
    );
})();
