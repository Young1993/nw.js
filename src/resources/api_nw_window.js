var Binding = require('binding').Binding;
var nw_binding = require('binding').Binding.create('nw.Window');
var nwNatives = requireNative('nw_natives');
var forEach = require('utils').forEach;
var Event = require('event_bindings').Event;
var dispatchEvent = require('event_bindings').dispatchEvent;
var sendRequest = require('sendRequest');

var currentNWWindow = null;
var currentNWWindowInternal = null;
var currentRoutingID = nwNatives.getRoutingID();

var nw_internal = require('binding').Binding.create('nw.currentWindowInternal');

var try_hidden = function (view) {
  if (view.chrome.app.window)
    return view;
  return privates(view);
};

var try_nw = function (view) {
  if (view.nw)
    return view;
  return privates(view);
};

function getPlatform() {
  var platforms = [
    [/CrOS Touch/, "chromeos touch"],
    [/CrOS/, "chromeos"],
    [/Linux/, "linux"],
    [/Mac/, "mac"],
    [/Win/, "win"],
  ];

  for (var i = 0; i < platforms.length; i++) {
    if ($RegExp.test(platforms[i][0], navigator.appVersion)) {
      return platforms[i][1];
    }
  }
  return "unknown";
}

var canSetVisibleOnAllWorkspaces = /(mac|linux)/.test(getPlatform());
var appWinEventsMap = {
  'minimize':         'onMinimized',
  'maximize':         'onMaximized',
  'restore':          'onRestored',
  'resize':           'onResized',
  'move':             'onMoved',
  'enter-fullscreen': 'onFullscreened',
  'closed':           'onClosed'
};

var nwWinEventsMap = {
  'zoom':             'onZoom',
  'close':            'onClose',
  'document-start':   'onDocumentStart',
  'document-end':     'onDocumentEnd'
};

var nwWrapEventsMap = {
  'loaded':           'LoadingStateChanged',
  'new-win-policy':   'onNewWinPolicy',
  'navigation':       'onNavigation'
};

nw_internal.registerCustomHook(function(bindingsAPI) {
  var apiFunctions = bindingsAPI.apiFunctions;
  apiFunctions.setHandleRequest('getZoom', function() {
    return sendRequest.sendRequestSync('nw.currentWindowInternal.getZoom', arguments, this.definition.parameters, {})[0];
  });
  apiFunctions.setHandleRequest('setZoom', function() {
    return sendRequest.sendRequestSync('nw.currentWindowInternal.setZoom', arguments, this.definition.parameters, {});
  });
  apiFunctions.setHandleRequest('getTitleInternal', function() {
    return sendRequest.sendRequestSync('nw.currentWindowInternal.getTitleInternal', arguments, this.definition.parameters, {})[0];
  });
  apiFunctions.setHandleRequest('setTitleInternal', function() {
    return sendRequest.sendRequestSync('nw.currentWindowInternal.setTitleInternal', arguments, this.definition.parameters, {});
  });
  apiFunctions.setHandleRequest('isKioskInternal', function() {
    return sendRequest.sendRequestSync('nw.currentWindowInternal.isKioskInternal', arguments, this.definition.parameters, {})[0];
  });
  apiFunctions.setHandleRequest('getWinParamInternal', function() {
    return sendRequest.sendRequestSync('nw.currentWindowInternal.getWinParamInternal', arguments, this.definition.parameters, {})[0];
  });
});

nw_binding.registerCustomHook(function(bindingsAPI) {
  var apiFunctions = bindingsAPI.apiFunctions;
  apiFunctions.setHandleRequest('get', function(domWindow) {
    if (domWindow)
      return try_nw(domWindow).nw.Window.get();
    if (currentNWWindow)
      return currentNWWindow;

    currentNWWindowInternal = nw_internal.generate();
    var NWWindow = function() {
      this.appWindow = try_hidden(window).chrome.app.window.current();
      if (!this.appWindow) {
        var winParam = currentNWWindowInternal.getWinParamInternal();
        try_hidden(window).chrome.app.window.initializeAppWindow(winParam);
        this.appWindow = try_hidden(window).chrome.app.window.current();
        if (!this.appWindow)
          console.error('The JavaScript context calling ' +
                        'nw.Window.get() has no associated AppWindow.');
      }
      privates(this).menu = null;
    };
    forEach(currentNWWindowInternal, function(key, value) {
      if (!key.endsWith('Internal'))
        NWWindow.prototype[key] = value;
    });

    NWWindow.prototype.onNewWinPolicy      = new Event();
    NWWindow.prototype.onNavigation        = new Event();
    NWWindow.prototype.LoadingStateChanged = new Event();
    NWWindow.prototype.onDocumentStart     = new Event();
    NWWindow.prototype.onDocumentEnd       = new Event();
    NWWindow.prototype.onZoom              = new Event();
    NWWindow.prototype.onClose             = new Event("nw.Window.onClose", undefined, {supportsFilters: true});

    NWWindow.prototype.once = function (event, listener) {
      if (typeof listener !== 'function')
        throw new TypeError('listener must be a function');
      var fired = false;
      var self = this;

      function g() {
        self.removeListener(event, g);
        if (!fired) {
          fired = true;
          listener.apply(self, arguments);
        }
      }
      this.on(event, g);
      return this;
    };

    NWWindow.prototype.on = function (event, callback) {
      if (event === 'close') {
        this.onClose.addListener(callback, {instanceId: currentRoutingID});
        return this;
      }
      if (appWinEventsMap.hasOwnProperty(event)) {
        this.appWindow[appWinEventsMap[event]].addListener(callback);
        return this;
      }
      if (nwWinEventsMap.hasOwnProperty(event)) {
        this[nwWinEventsMap[event]].addListener(callback);
        return this;
      }
      switch (event) {
      case 'focus':
        this.appWindow.contentWindow.onfocus = callback;
        break;
      case 'blur':
        this.appWindow.contentWindow.onblur = callback;
        break;
      case 'loaded':
        function g(status) {
          if (status == 'loaded')
            callback();
        }
        g.listener = callback;
        this.LoadingStateChanged.addListener(g);
        break;
      case 'new-win-policy':
        function h(frame, url, policy) {
          policy.ignore         =  function () { this.val = 'ignore'; };
          policy.forceCurrent   =  function () { this.val = 'current'; };
          policy.forceDownload  =  function () { this.val = 'download'; };
          policy.forceNewWindow =  function () { this.val = 'new-window'; };
          policy.forceNewPopup  =  function () { this.val = 'new-popup'; };
          policy.setNewWindowManifest = function (m) { this.manifest = JSON.stringify(m); };
          callback(frame, url, policy);
        }
        h.listener = callback;
        this.onNewWinPolicy.addListener(h);
        break;
      case 'navigation':
        function j(frame, url, policy, context) {
          policy.ignore         =  function () { this.val = 'ignore'; };
          callback(frame, url, policy, context);
        }
        j.listener = callback;
        this.onNavigation.addListener(j);
        break;
      }
      return this;
    };
    NWWindow.prototype.removeListener = function (event, callback) {
      if (appWinEventsMap.hasOwnProperty(event)) {
        this.appWindow[appWinEventsMap[event]].removeListener(callback);
        return this;
      }
      if (nwWinEventsMap.hasOwnProperty(event)) {
        this[nwWinEventsMap[event]].removeListener(callback);
        return this;
      }
      if (nwWrapEventsMap.hasOwnProperty(event)) {
        for (let l of this[nwWrapEventsMap[event]].getListeners()) {
          if (l.callback.listener && l.callback.listener === callback) {
            this[nwWrapEventsMap[event]].removeListener(l.callback);
            return this;
          }
        }
      }
      switch (event) {
      case 'focus':
        if (this.appWindow.contentWindow.onfocus === callback)
          this.appWindow.contentWindow.onfocus = null;
        break;
      case 'blur':
        if (this.appWindow.contentWindow.onblur === callback)
          this.appWindow.contentWindow.onblur = null;
        break;
      }
      return this;
    };

    NWWindow.prototype.removeAllListeners = function (event) {
      if (appWinEventsMap.hasOwnProperty(event)) {
        for (let l of
             this.appWindow[appWinEventsMap[event]].getListeners()) {
          this.appWindow[appWinEventsMap[event]].removeListener(l.callback);
        }
        return this;
      }
      if (nwWinEventsMap.hasOwnProperty(event)) {
        for (let l of
             this[nwWinEventsMap[event]].getListeners()) {
          this[nwWinEventsMap[event]].removeListener(l.callback);
        }
        return this;
      }
      if (nwWrapEventsMap.hasOwnProperty(event)) {
        for (let l of this[nwWrapEventsMap[event]].getListeners()) {
            this[nwWrapEventsMap[event]].removeListener(l.callback);
            return this;
        }
      }
      switch (event) {
      case 'focus':
          this.appWindow.contentWindow.onfocus = null;
        break;
      case 'blur':
          this.appWindow.contentWindow.onblur = null;
        break;
      }
      return this;
    };

    NWWindow.prototype.showDevTools = function(frm, headless, callback) {
      nwNatives.setDevToolsJail(frm);
      currentNWWindowInternal.showDevToolsInternal(callback);
    };
    NWWindow.prototype.capturePage = function (callback, options) {
      var cb = callback;
      if (!options)
        options = {'format':'jpeg', 'datatype':'datauri'};
      if (typeof options == 'string')
        options = {'format':options, 'datatype':'datauri'};
      if (options.datatype != 'datauri') {
        cb = function (format, datauri) {
          var raw = datauri.replace(/^data:[^;]*;base64,/, '');
          switch(format){
          case 'buffer' :
            callback(new nw.Buffer(raw, "base64"));
            break;
          case 'raw' :
            callback(raw);
            break;
          }
        };
        cb = cb.bind(undefined, options.datatype);
      }
      currentNWWindowInternal.capturePageInternal(options, cb);
    };
    NWWindow.prototype.reload = function () {
      this.appWindow.contentWindow.location.reload();
    };
    NWWindow.prototype.reloadIgnoringCache = function () {
      currentNWWindowInternal.reloadIgnoringCache();
    };
    NWWindow.prototype.eval = function (frame, script) {
      nwNatives.evalScript(frame, script);
    };
    NWWindow.prototype.evalNWBin = function (frame, path) {
      nwNatives.evalNWBin(frame, path);
    };
    NWWindow.prototype.show = function () {
      this.appWindow.show();
    };
    NWWindow.prototype.hide = function () {
      this.appWindow.hide();
    };
    NWWindow.prototype.focus = function () {
      this.appWindow.focus();
    };
    NWWindow.prototype.blur = function () {
      this.appWindow.contentWindow.blur();
    };
    NWWindow.prototype.minimize = function () {
      this.appWindow.minimize();
    };
    NWWindow.prototype.maximize = function () {
      this.appWindow.maximize();
    };
    NWWindow.prototype.unmaximize = NWWindow.prototype.restore = function () {
      this.appWindow.restore();
    };
    NWWindow.prototype.enterFullscreen = function () {
      this.appWindow.fullscreen();
    };
    NWWindow.prototype.leaveFullscreen = function () {
      if (this.appWindow.isFullscreen())
        this.appWindow.restore();
    };
    NWWindow.prototype.toggleFullscreen = function () {
      if (this.appWindow.isFullscreen())
        this.appWindow.restore();
      else
        this.appWindow.fullscreen();
    };
    NWWindow.prototype.setAlwaysOnTop = function (top) {
      this.appWindow.setAlwaysOnTop(top);
    };
    NWWindow.prototype.isAlwaysOnTop = function () {
      return this.appWindow.isAlwaysOnTop();
    };
    NWWindow.prototype.setPosition = function (pos) {
      if (pos == "center") {
        var screenWidth = screen.availWidth;
        var screenHeight = screen.availHeight;
        var width  = this.appWindow.outerBounds.width;
        var height = this.appWindow.outerBounds.height;
        this.appWindow.outerBounds.setPosition(Math.round((screenWidth-width)/2),
                                               Math.round((screenHeight-height)/2));
      }
    };
    NWWindow.prototype.isFullscreen = function () {
      return this.appWindow.isFullscreen();
    };
    NWWindow.prototype.setVisibleOnAllWorkspaces = function(all_visible) {
      this.appWindow.setVisibleOnAllWorkspaces(all_visible);
    };
    NWWindow.prototype.canSetVisibleOnAllWorkspaces = function() {
      return canSetVisibleOnAllWorkspaces;
    };
    NWWindow.prototype.setMaximumSize = function (width, height) {
      this.appWindow.outerBounds.maxWidth = width;
      this.appWindow.outerBounds.maxHeight = height;
    };
    NWWindow.prototype.setMinimumSize = function (width, height) {
      this.appWindow.outerBounds.minWidth = width;
      this.appWindow.outerBounds.minHeight = height;
    };
    NWWindow.prototype.resizeTo = function (width, height) {
      this.appWindow.outerBounds.width = width;
      this.appWindow.outerBounds.height = height;
    };
    NWWindow.prototype.resizeBy = function (width, height) {
      this.appWindow.outerBounds.width += width;
      this.appWindow.outerBounds.height += height;
    };
    NWWindow.prototype.moveTo = function (x, y) {
      this.appWindow.outerBounds.left = x;
      this.appWindow.outerBounds.top = y;
    };
    NWWindow.prototype.moveBy = function (x, y) {
      this.appWindow.outerBounds.left += x;
      this.appWindow.outerBounds.top += y;
    };
    NWWindow.prototype.setResizable = function (resizable) {
      this.appWindow.setResizable(resizable);
    };
    NWWindow.prototype.requestAttention = function (flash) {
      if (typeof flash == 'boolean')
        flash = flash ? -1 : 0;
      currentNWWindowInternal.requestAttentionInternal(flash);
    };
    NWWindow.prototype.cookies = chrome.cookies;

    Object.defineProperty(NWWindow.prototype, 'x', {
      get: function() {
        return this.appWindow.outerBounds.left;
      },
      set: function(x) {
        this.appWindow.outerBounds.left = x;
      }
    });
    Object.defineProperty(NWWindow.prototype, 'y', {
      get: function() {
        return this.appWindow.outerBounds.top;
      },
      set: function(y) {
        this.appWindow.outerBounds.top = y;
      }
    });
    Object.defineProperty(NWWindow.prototype, 'width', {
      get: function() {
        return this.appWindow.innerBounds.width;
      },
      set: function(val) {
        this.appWindow.innerBounds.width = val;
      }
    });
    Object.defineProperty(NWWindow.prototype, 'height', {
      get: function() {
        return this.appWindow.innerBounds.height;
      },
      set: function(val) {
        this.appWindow.innerBounds.height = val;
      }
    });
    Object.defineProperty(NWWindow.prototype, 'title', {
      get: function() {
        return currentNWWindowInternal.getTitleInternal();
      },
      set: function(val) {
        currentNWWindowInternal.setTitleInternal(val);
      }
    });
    Object.defineProperty(NWWindow.prototype, 'zoomLevel', {
      get: function() {
        return currentNWWindowInternal.getZoom();
      },
      set: function(val) {
        currentNWWindowInternal.setZoom(val);
      }
    });
    Object.defineProperty(NWWindow.prototype, 'isTransparent', {
      get: function() {
        return this.appWindow.alphaEnabled;
      }
    });
    Object.defineProperty(NWWindow.prototype, 'isKioskMode', {
      get: function() {
        return currentNWWindowInternal.isKioskInternal();
      },
      set: function(val) {
        if (val)
          currentNWWindowInternal.enterKioskMode();
        else
          currentNWWindowInternal.leaveKioskMode();
      }
    });
    Object.defineProperty(NWWindow.prototype, 'menu', {
      get: function() {
        var ret = privates(this).menu || {};
        return ret;
      },
      set: function(menu) {
        if(!menu) {
          currentNWWindowInternal.clearMenu();
          return;
        }
        if (menu.type != 'menubar')
          throw new TypeError('Only menu of type "menubar" can be used as this.window menu');

        privates(this).menu =  menu;
        currentNWWindowInternal.setMenu(menu.id);
      }
    });
    Object.defineProperty(NWWindow.prototype, 'window', {
      get: function() {
        return this.appWindow.contentWindow;
      }
    });
    currentNWWindow = new NWWindow;
    return currentNWWindow;
  });

  apiFunctions.setHandleRequest('open', function(url, params, callback) {
    var options = {};
    //FIXME: unify this conversion code with nwjs/default.js
    options.innerBounds = {};
    options.outerBounds = {};
    if (params) {
      if (params.frame === false)
        options.frame = 'none';
      if (params.resizable === false)
        options.resizable = false;
      if (params.focus === false)
        options.focused = false;
      if (params.x)
        options.outerBounds.left = params.x;
      if (params.y)
        options.outerBounds.top = params.y;
      if (params.height)
        options.innerBounds.height = params.height;
      if (params.width)
        options.innerBounds.width = params.width;
      if (params.min_width)
        options.innerBounds.minWidth = params.min_width;
      if (params.max_width)
        options.innerBounds.maxWidth = params.max_width;
      if (params.min_height)
        options.innerBounds.minHeight = params.min_height;
      if (params.max_height)
        options.innerBounds.maxHeight = params.max_height;
      if (params.fullscreen === true)
        options.state = 'fullscreen';
      if (params.show === false)
        options.hidden = true;
      if (params.show_in_taskbar === false)
        options.show_in_taskbar = false;
      if (params['always_on_top'] === true)
        options.alwaysOnTop = true;
      if (params['visible_on_all_workspaces'] === true)
        options.visibleOnAllWorkspaces = true;
      if (typeof params['inject_js_start'] == 'string')
        options.inject_js_start = params['inject_js_start'];
      if (typeof params['inject_js_end'] == 'string')
        options.inject_js_end = params['inject_js_end'];
      if (params.transparent)
        options.alphaEnabled = true;
      if (params.kiosk === true)
        options.kiosk = true;
      if (params.position)
        options.position = params.position;
      if (params.title)
        options.title = params.title;
      if (params.icon)
        options.icon = params.icon;
      if (params.id)
        options.id = params.id;
    }
    try_hidden(window).chrome.app.window.create(url, options, function(appWin) {
      if (callback) {
        if (appWin)
          callback(try_nw(appWin.contentWindow).nw.Window.get());
        else
          callback();
      }
    });
  });

});

function dispatchEventIfExists(target, name, varargs) {
  // Sometimes apps like to put their own properties on the window which
  // break our assumptions.
  var event = target[name];
  if (event && (typeof event.dispatch == 'function'))
    $Function.apply(event.dispatch, event, varargs);
  else
    console.warn('Could not dispatch ' + name + ', event has been clobbered');
}

function onNewWinPolicy(frame, url, policy) {
  //console.log("onNewWinPolicy called: " + url + ", " + policy);
  if (!currentNWWindow)
    return;
  dispatchEventIfExists(currentNWWindow, "onNewWinPolicy", [frame, url, policy]);
}

function onNavigation(frame, url, policy, context) {
  //console.log("onNavigation called: " + url + ", " + context);
  if (!currentNWWindow)
    return;
  dispatchEventIfExists(currentNWWindow, "onNavigation", [frame, url, policy, context]);
}

function onLoadingStateChanged(status) {
  //console.log("onLoadingStateChanged: " + status);
  if (!currentNWWindow)
    return;
  dispatchEventIfExists(currentNWWindow, "LoadingStateChanged", [status]);
}

function onDocumentStartEnd(start, frame) {
  if (!currentNWWindow)
    return;
  if (start)
    dispatchEventIfExists(currentNWWindow, "onDocumentStart", [frame]);
  else
    dispatchEventIfExists(currentNWWindow, "onDocumentEnd", [frame]);
}

function updateAppWindowZoom(old_level, new_level) {
  if (!currentNWWindow)
    return;
  dispatchEventIfExists(currentNWWindow, "onZoom", [new_level]);
}

function onClose() {
  if (!currentNWWindow)
    return;
  dispatchEvent("nw.Window.onClose", [], {instanceId: currentRoutingID});
}

exports.binding = nw_binding.generate();
exports.onNewWinPolicy = onNewWinPolicy;
exports.onNavigation = onNavigation;
exports.LoadingStateChanged = onLoadingStateChanged;
exports.onDocumentStartEnd = onDocumentStartEnd;
exports.onClose = onClose;
exports.updateAppWindowZoom = updateAppWindowZoom;
