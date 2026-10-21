/**
 * 渲染进程脚本：只通过 preload 暴露的 window.desktop 白名单 API 与主进程通信。
 * 不接触 Node / 文件系统 / ipcRenderer；所有动态文本一律用 textContent 写入，避免 XSS。
 */
(function () {
  "use strict";

  var api = window.desktop;
  if (!api) {
    document.body.textContent = "预加载脚本缺失：渲染进程无法访问桌面 API。";
    return;
  }

  var MAX_LOG_ROWS = 1000;
  var logs = [];
  var companion = null;
  var toastTimer = null;

  function $(id) {
    return document.getElementById(id);
  }

  function text(id, value) {
    var node = $(id);
    if (node) node.textContent = value;
  }

  function toast(message, ok) {
    var node = $("toast");
    if (!node) return;
    node.textContent = message;
    node.className = "toast " + (ok ? "ok" : "err");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      node.textContent = "";
      node.className = "toast";
    }, 5000);
  }

  function errorText(error) {
    if (error && typeof error.message === "string" && error.message.length > 0) {
      return error.message;
    }
    return "操作失败（详情见主进程）";
  }

  function formatTime(value) {
    if (!value) return "—";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    var pad = function (n) {
      return String(n).padStart(2, "0");
    };
    return (
      date.getFullYear() +
      "-" +
      pad(date.getMonth() + 1) +
      "-" +
      pad(date.getDate()) +
      " " +
      pad(date.getHours()) +
      ":" +
      pad(date.getMinutes()) +
      ":" +
      pad(date.getSeconds())
    );
  }

  // ── 页签 ───────────────────────────────────────────────────────────────
  Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (tab) {
    tab.addEventListener("click", function () {
      var name = tab.getAttribute("data-tab");
      Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (item) {
        item.classList.toggle("active", item === tab);
      });
      Array.prototype.forEach.call(document.querySelectorAll(".panel"), function (panel) {
        panel.classList.toggle("active", panel.id === "panel-" + name);
      });
    });
  });

  // ── 状态渲染 ───────────────────────────────────────────────────────────
  function renderStatus(status) {
    if (!status) return;
    text("run-state", status.running ? "运行中" : "未运行");
    $("run-state").className = "big " + (status.running ? "state-running" : "");
    text("run-since", status.running && status.startedAt ? "启动于 " + formatTime(status.startedAt) : "—");
    text("route-count", String(status.routeCount || 0));
    text("gateway-host", "网关：" + (status.gateway && status.gateway.baseUrlHost ? status.gateway.baseUrlHost : "—"));
    text("cross-border", "Telegram 出境闸门：" + (status.crossBorderOpen ? "OPEN" : "CLOSED"));
    text("count-forwarded", String(status.counts ? status.counts.forwarded : 0));
    text("count-failed", String(status.counts ? status.counts.failed : 0));
    text("count-skipped", String(status.counts ? status.counts.skipped : 0));
    $("btn-start").disabled = status.running === true;
    $("btn-stop").disabled = status.running !== true;
  }

  // ── 伴生服务渲染 ───────────────────────────────────────────────────────
  function renderCompanion(state) {
    if (!state) return;
    companion = state;
    text("companion-address", state.address || "—");
    text("companion-running", state.running ? "监听中" : "未运行");
    text("companion-static", state.staticAvailable ? "可用（companion-web）" : "缺失（/ 返回 503，API 仍可用）");
    text("companion-cred", state.credentialsPersistent ? "safeStorage 加密持久化" : "仅内存（safeStorage 不可用）");
    text("pair-code", state.pairCode || "—（已使用，点击右侧换一个）");
    $("companion-port").value = String(state.port);
    $("lan-mode").checked = state.lanMode === true;
    $("lan-warning").hidden = !state.warning;
    text("lan-warning", state.warning || "");
    $("companion-error").hidden = !state.error;
    text("companion-error", state.error || "");
    updatePairExpiry();
  }

  function updatePairExpiry() {
    if (!companion) return;
    if (!companion.pairCode || !companion.pairCodeExpiresAt) {
      text("pair-expire", "配对码已失效：请点击「换一个配对码」再让手机配对。");
      return;
    }
    var left = companion.pairCodeExpiresAt - Date.now();
    if (left <= 0) {
      text("pair-expire", "配对码已过期：请点击「换一个配对码」。");
      return;
    }
    var minutes = Math.floor(left / 60000);
    var seconds = Math.floor((left % 60000) / 1000);
    text("pair-expire", "剩余有效时间 " + minutes + " 分 " + String(seconds).padStart(2, "0") + " 秒");
  }
  setInterval(updatePairExpiry, 1000);

  // ── 令牌渲染 ───────────────────────────────────────────────────────────
  function renderToken(status) {
    if (!status) return;
    var sourceText = { safeStorage: "已保存（safeStorage 加密）", env: "来自环境变量", none: "未配置" };
    text("token-state", sourceText[status.source] || "未配置");
    text("token-env", status.tokenEnv || "EASYBOT_TOKEN");
    text("token-safe", status.encryptionAvailable ? "可用" : "不可用（只能用环境变量）");
    $("btn-save-token").disabled = !status.encryptionAvailable;
    $("btn-clear-token").disabled = status.source !== "safeStorage";
  }

  // ── 配置校验结果 ───────────────────────────────────────────────────────
  function renderViolations(violations) {
    var box = $("violations");
    box.textContent = "";
    if (!violations || violations.length === 0) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    var title = document.createElement("h3");
    title.textContent = "校验未通过（" + violations.length + " 项）· 违规只能报错，不会自动修正或绕过";
    box.appendChild(title);
    violations.forEach(function (violation) {
      var item = document.createElement("div");
      item.className = "violation";
      var code = document.createElement("span");
      code.className = "code";
      code.textContent = violation.code || "UNKNOWN";
      item.appendChild(code);
      var message = document.createElement("span");
      message.textContent = violation.message || "";
      item.appendChild(message);
      if (violation.hint) {
        var hint = document.createElement("p");
        hint.className = "hint";
        hint.textContent = violation.hint;
        item.appendChild(hint);
      }
      box.appendChild(item);
    });
  }

  // ── 日志渲染 ───────────────────────────────────────────────────────────
  function logStatusClass(status) {
    if (!status) return "";
    if (status === "forwarded") return "status-forwarded";
    if (status === "send_failed") return "status-send_failed";
    if (status.indexOf("skipped_") === 0 || status.indexOf("blocked_") === 0) return "status-skipped";
    return "";
  }

  function buildRow(record) {
    var tr = document.createElement("tr");
    var columns = [
      { value: formatTime(record.ts), className: "" },
      { value: record.level || "", className: "level-" + (record.level || "") },
      { value: record.event || "", className: "" },
      { value: record.routeId || "", className: "" },
      { value: record.sourcePlatform || "", className: "" },
      { value: record.targetPlatform || "", className: "" },
      { value: record.status || "", className: logStatusClass(record.status) },
      { value: record.errorCode || "", className: record.level === "error" ? "level-error" : "" },
      { value: record.latencyMs === undefined ? "" : String(record.latencyMs), className: "" },
    ];
    columns.forEach(function (column) {
      var td = document.createElement("td");
      td.textContent = column.value;
      if (column.className) td.className = column.className;
      tr.appendChild(td);
    });
    return tr;
  }

  function renderLogs() {
    var body = $("log-body");
    body.textContent = "";
    var fragment = document.createDocumentFragment();
    logs.forEach(function (record) {
      fragment.appendChild(buildRow(record));
    });
    body.appendChild(fragment);
  }

  function appendLog(record) {
    if (!record) return;
    logs.unshift(record);
    if (logs.length > MAX_LOG_ROWS) logs.length = MAX_LOG_ROWS;
    var body = $("log-body");
    body.insertBefore(buildRow(record), body.firstChild);
    while (body.childNodes.length > MAX_LOG_ROWS) {
      body.removeChild(body.lastChild);
    }
  }

  // ── 关于 ───────────────────────────────────────────────────────────────
  function renderAbout(info) {
    if (!info) return;
    text("about-name", info.name || "im-forwarder");
    text("about-version", info.version || "—");
    text(
      "about-runtime",
      (info.electronVersion || "—") + " / " + (info.nodeVersion || "—") + " / " + (info.chromeVersion || "—"),
    );
    text("about-platform", info.platform || "—");
    text("about-config", info.configPath || "—");
    text("about-signed", info.signed ? "已签名" : "未签名构建（不提供自动更新）");
    text("about-license", info.license || "—");
  }

  // ── 初始化 ─────────────────────────────────────────────────────────────
  function loadLogs(limit) {
    return api.getLogs(limit).then(function (records) {
      logs = Array.isArray(records) ? records.slice().reverse() : [];
      renderLogs();
    });
  }

  function refreshConfig() {
    return api.getConfig().then(function (state) {
      text("config-path", (state.path || "—") + (state.exists ? "" : "（不存在，保存时创建）"));
      var editor = $("config-editor");
      if (!editor.value || state.exists) {
        editor.value = state.content || "";
      }
      if (state.error) toast(state.error, false);
    });
  }

  function init() {
    loadLogs(Number($("log-limit").value) || 100).catch(function () {
      /* 首次加载失败不阻塞界面 */
    });
    Promise.all([
      api.getStatus(),
      api.getCompanionState(),
      api.getTokenStatus(),
      api.getAppInfo(),
      api.getConfig(),
    ])
      .then(function (results) {
        renderStatus(results[0]);
        renderCompanion(results[1]);
        renderToken(results[2]);
        renderAbout(results[3]);
        text("config-path", (results[4].path || "—") + (results[4].exists ? "" : "（不存在，保存时创建）"));
        $("config-editor").value = results[4].content || "";
        if (results[4].error) toast(results[4].error, false);
      })
      .catch(function (error) {
        toast(errorText(error), false);
      });

    api.onStatus(renderStatus);
    api.onCompanion(renderCompanion);
    api.onLog(appendLog);
  }

  // ── 按钮行为 ───────────────────────────────────────────────────────────
  $("btn-start").addEventListener("click", function () {
    $("btn-start").disabled = true;
    api
      .start()
      .then(function (result) {
        if (result.ok) {
          toast("核心转发进程已启动", true);
        } else {
          toast("启动失败：" + (result.violations && result.violations[0] ? result.violations[0].code : "未知原因"), false);
          renderViolations(result.violations);
        }
        return api.getStatus().then(renderStatus);
      })
      .catch(function (error) {
        toast(errorText(error), false);
        $("btn-start").disabled = false;
      });
  });

  $("btn-stop").addEventListener("click", function () {
    $("btn-stop").disabled = true;
    api
      .stop()
      .then(function () {
        toast("核心转发进程已停止", true);
        return api.getStatus().then(renderStatus);
      })
      .catch(function (error) {
        toast(errorText(error), false);
        $("btn-stop").disabled = false;
      });
  });

  $("btn-validate").addEventListener("click", function () {
    var yaml = $("config-editor").value;
    text("config-status", "校验中…");
    api
      .validateConfig(yaml)
      .then(function (result) {
        renderViolations(result.violations);
        text("config-status", result.ok ? "校验通过（未保存）" : "校验未通过，未保存");
        toast(result.ok ? "配置校验通过" : "配置存在违规，已列出原因", result.ok);
      })
      .catch(function (error) {
        text("config-status", "校验失败");
        toast(errorText(error), false);
      });
  });

  $("btn-save-config").addEventListener("click", function () {
    var yaml = $("config-editor").value;
    text("config-status", "保存中…");
    api
      .saveConfig(yaml)
      .then(function (result) {
        if (result.saved) {
          renderViolations([]);
          text("config-status", "已保存 · 路由 " + result.routeCount + " 条；运行中的核心进程需停止后重新启动以生效");
          toast("配置已保存", true);
          api.getCompanionState().then(renderCompanion);
        } else {
          renderViolations(result.violations);
          text("config-status", "未保存：存在违规");
          toast("配置未保存：请按下方提示修正后再试", false);
        }
      })
      .catch(function (error) {
        text("config-status", "保存失败");
        toast(errorText(error), false);
      });
  });

  $("btn-restore-example").addEventListener("click", function () {
    api
      .getExampleConfig()
      .then(function (content) {
        $("config-editor").value = content;
        renderViolations([]);
        text("config-status", "已载入示例（尚未保存）");
        toast("已载入示例配置，确认后点击保存", true);
      })
      .catch(function (error) {
        toast(errorText(error), false);
      });
  });

  $("btn-save-token").addEventListener("click", function () {
    var input = $("token-input");
    var value = input.value;
    if (!value.trim()) {
      toast("请输入令牌", false);
      return;
    }
    api
      .setToken(value)
      .then(function (status) {
        input.value = "";
        renderToken(status);
        text("config-status", "令牌已保存（不回显）");
        toast("令牌已加密保存", true);
      })
      .catch(function (error) {
        input.value = "";
        toast(errorText(error), false);
      });
  });

  $("btn-clear-token").addEventListener("click", function () {
    api
      .clearToken()
      .then(function (status) {
        renderToken(status);
        toast("已清除本机保存的令牌（环境变量不受影响）", true);
      })
      .catch(function (error) {
        toast(errorText(error), false);
      });
  });

  $("btn-new-pair").addEventListener("click", function () {
    api
      .newPairCode()
      .then(function (state) {
        renderCompanion(state);
        toast("已生成新的配对码", true);
      })
      .catch(function (error) {
        toast(errorText(error), false);
      });
  });

  $("lan-mode").addEventListener("change", function (event) {
    var enabled = event.target.checked;
    if (enabled) {
      var acknowledged = window.confirm(
        "局域网模式会让伴生 API 监听 0.0.0.0，同一局域网内的其他设备都可能尝试连接。\n\n" +
          "请确认：\n" +
          "· 只在可信网络（家庭/个人热点）使用；\n" +
          "· 配对码只给你的手机，用完点击「换一个配对码」；\n" +
          "· 无令牌访问一律 401，配置只读，不提供正文接口。\n\n" +
          "确定开启吗？",
      );
      if (!acknowledged) {
        event.target.checked = false;
        return;
      }
      api
        .setLanMode(true, true)
        .then(renderCompanion)
        .catch(function (error) {
          event.target.checked = false;
          toast(errorText(error), false);
        });
    } else {
      api
        .setLanMode(false, true)
        .then(renderCompanion)
        .catch(function (error) {
          event.target.checked = true;
          toast(errorText(error), false);
        });
    }
  });

  $("btn-save-port").addEventListener("click", function () {
    var port = Number($("companion-port").value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      toast("端口必须是 1024–65535 之间的整数", false);
      return;
    }
    api
      .setCompanionPort(port)
      .then(function (state) {
        renderCompanion(state);
        toast("端口已更新（伴生服务已重启）", true);
      })
      .catch(function (error) {
        toast(errorText(error), false);
      });
  });

  $("btn-clear-logs").addEventListener("click", function () {
    logs = [];
    renderLogs();
    toast("已清空界面显示（内存环形缓冲仍保留，最多 1000 条）", true);
  });

  $("log-limit").addEventListener("change", function () {
    loadLogs(Number($("log-limit").value) || 100).catch(function (error) {
      toast(errorText(error), false);
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll("[data-open]"), function (button) {
    button.addEventListener("click", function () {
      var url = button.getAttribute("data-open");
      api.openExternal(url).then(function (opened) {
        if (!opened) toast("该链接不在白名单内，已拒绝打开", false);
      });
    });
  });

  init();
})();
