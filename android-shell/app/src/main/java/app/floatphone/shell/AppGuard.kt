package app.floatphone.shell

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar

/**
 * 应用守卫：关注应用「一打开就拉回小手机」+ 睡眠时段「锁住娱乐应用」+
 * 单应用连续用太久「强制回小手机 / 全屏锁定」。
 *
 * 为什么必须在原生做：网页 JS 切到别的 App 后会被系统节流、甚至冻结，
 * 靠网页发现「TA 打开了抖音」再拉回，往往已经过了几十秒。无障碍服务本来就
 * 实时收到前台包名事件，判断放这里才能做到「一打开就拦」。
 *
 * 配置由网页通过 AndroidShell.setAppGuardConfig() 写进来，落在
 * SharedPreferences——进程被杀、网页没开时，规则照样生效。
 *
 * 边界：只拦「用户自己列出的应用」；睡眠锁 / 用太久列表为空时才拦所有非小手机应用。
 * 小手机自己（app.floatphone.shell）永远不拦，否则用户会被锁在外面回不来。
 */
class AppGuard(private val context: Context) {

    companion object {
        private const val PREFS = "app_guard"
        private const val KEY_CONFIG = "config"
        private const val SELF_PACKAGE = "app.floatphone.shell"
        private const val SNOOZE_MS = 5 * 60 * 1000L
        private const val RETURN_COOLDOWN_MS = 30 * 1000L
        /** 遮罩刚出现后忽略「自己」的前台事件，避免自己的窗口事件把遮罩关掉。 */
        private const val OVERLAY_GRACE_MS = 3000L
        /** 「用太久」的定时检查间隔。计时精度到分钟，一分钟查一次就够。 */
        private const val OVERUSE_CHECK_MS = 60 * 1000L
        /** 处置过后多久内不再重复处置，避免刚拉回去又被立刻再拉一次。 */
        private const val OVERUSE_COOLDOWN_MS = 5 * 60 * 1000L

        @Volatile
        private var overlayView: View? = null

        @Volatile
        private var overlayShownAt = 0L

        @Volatile
        private var snoozeUntil = 0L

        @Volatile
        private var lastReturnAt = 0L

        /** 当前前台包名与这段停留的起算时刻（切到别的 App 就重新起算）。 */
        @Volatile
        private var currentForeground = ""
        @Volatile
        private var foregroundSince = 0L

        /** 已处置过的应用与时刻，用于冷却期内不重复处置。 */
        @Volatile
        private var overuseHandledPkg = ""
        @Volatile
        private var overuseHandledAt = 0L

        /** 正在被「用太久 → 锁定」的应用包名；空串 = 没有锁定。 */
        @Volatile
        private var lockedPkg = ""

        /** 「用太久」定时检查是否已在跑，防止重复投递。 */
        @Volatile
        private var watchdogRunning = false

        /** 最近创建的实例，供定时检查使用。 */
        @Volatile
        private var liveInstance: AppGuard? = null

        private val mainHandler by lazy { Handler(Looper.getMainLooper()) }

        /** 定时检查「连续用太久」的看门狗。 */
        private val watchdog = Runnable { liveInstance?.watchdogTick() }
    }

    init {
        liveInstance = this
    }

    // ── 配置读写 ──

    /** 网页写入守卫配置（JSON）。 */
    fun saveConfig(json: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(KEY_CONFIG, json).apply()
        // 配置变了：如果当前时段已经不锁，立刻收起还在的遮罩。
        val root = runCatching { JSONObject(json) }.getOrNull() ?: JSONObject()
        val sleepOn = root.optBoolean("sleepLockEnabled", false) && isSleepWindow(root)
        val overuseOn = root.optBoolean("enabled", false) && root.optInt("overuseMinutes", 0) > 0
        if (!sleepOn && !overuseOn) {
            lockedPkg = ""
            postDismiss()
        }
        // 开了「用太久」就安排定时检查；配置里已经有前台应用时不必等下一次切换。
        if (overuseOn) ensureWatchdog()
    }

    /** 让网页读到当前配置（排障用，没配置时返回 {}）。 */
    fun readConfig(): String =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_CONFIG, "{}") ?: "{}"

    // ── 无障碍服务入口 ──

    /**
     * 每次前台应用变化时调用。
     *
     * 顺序：先维护连续前台计时，再判睡眠锁（命中就弹遮罩并结束），
     * 再判关注应用（拉回小手机）。都不会拦小手机自己。
     */
    fun onForeground(pkg: String) {
        if (pkg.isBlank()) return

        // 连续前台计时：切到别的应用就重新起算。
        // 这是「用太久」的唯一计时来源——网页在后台会被冻结，不能靠它数时间。
        if (pkg != currentForeground) {
            currentForeground = pkg
            foregroundSince = System.currentTimeMillis()
        }

        if (pkg == SELF_PACKAGE) {
            // 回到小手机：锁定自然解除
            lockedPkg = ""
            // 遮罩自己的窗口也可能派发事件，刚弹出时忽略，避免自关。
            if (overlayView == null || System.currentTimeMillis() - overlayShownAt > OVERLAY_GRACE_MS) {
                postDismiss()
            }
            return
        }

        // 离开了被锁的应用（去了别的 App）：锁不再适用于新应用
        if (lockedPkg.isNotBlank() && lockedPkg != pkg) {
            lockedPkg = ""
            postDismiss()
        }

        val root = runCatching { JSONObject(readConfig()) }.getOrNull() ?: return
        if (!root.optBoolean("enabled", false)) {
            postDismiss()
            return
        }

        if (root.optInt("overuseMinutes", 0) > 0) ensureWatchdog()

        val label = labelOf(pkg)

        if (root.optBoolean("sleepLockEnabled", false) && isSleepWindow(root)) {
            val list = root.optJSONArray("sleepLockApps")
            // 空列表 = 锁所有应用（「要求睡觉」的最直接解释）；列了应用才逐个匹配。
            val lockAll = list == null || list.length() == 0
            if ((lockAll || matches(list, pkg, label)) &&
                System.currentTimeMillis() >= snoozeUntil
            ) {
                showSleepOverlay(root.optString("sleepLockMessage", "该睡觉啦，把手机放下。"))
                return
            }
        } else {
            postDismiss()
        }

        if (root.optBoolean("returnToFloat", false) &&
            matches(root.optJSONArray("watchList"), pkg, label) &&
            System.currentTimeMillis() - lastReturnAt > RETURN_COOLDOWN_MS
        ) {
            lastReturnAt = System.currentTimeMillis()
            bringToFront()
        }
    }

    /** 把小手机自己拉到前台。成功返回 true。 */
    fun bringToFront(): Boolean = try {
        val intent = Intent(context, MainActivity::class.java).addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK
                or Intent.FLAG_ACTIVITY_SINGLE_TOP
                or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT,
        )
        context.startActivity(intent)
        true
    } catch (e: Throwable) {
        // 后台启动 Activity 在某些 ROM 上会被拦；失败就保持现状，不崩服务。
        false
    }

    // ── 单应用连续用太久 ──

    /** 安排「用太久」的定时检查（已在跑就不重复）。 */
    private fun ensureWatchdog() {
        if (watchdogRunning) return
        watchdogRunning = true
        mainHandler.postDelayed(watchdog, OVERUSE_CHECK_MS)
    }

    /**
     * 定时检查一次。
     *
     * 为什么用定时器而不是只在切换应用时判：用户可能一直停在同一个 App，
     * 不切前台就永远收不到事件——到点也不会被处置。
     */
    private fun watchdogTick() {
        val root = runCatching { JSONObject(readConfig()) }.getOrNull()
        if (root == null || !root.optBoolean("enabled", false) || root.optInt("overuseMinutes", 0) <= 0) {
            // 功能关了：停止循环，等下次写配置或切应用再启动。
            watchdogRunning = false
            return
        }
        checkOveruse(root)
        mainHandler.postDelayed(watchdog, OVERUSE_CHECK_MS)
    }

    /** 连续用满阈值就处置：回小手机 或 全屏锁定。 */
    private fun checkOveruse(root: JSONObject) {
        // 已经有遮罩（睡眠锁 / 上一次锁定）时不再叠加
        if (overlayView != null) return

        val minutes = root.optInt("overuseMinutes", 0)
        if (minutes <= 0) return

        val pkg = currentForeground
        if (pkg.isBlank() || pkg == SELF_PACKAGE) return
        val since = foregroundSince
        if (since <= 0L) return

        val list = root.optJSONArray("overuseApps")
        val lockList = root.optJSONArray("overuseLockApps")
        // 空列表 = 管除小手机外的所有应用
        val watchAll = list == null || list.length() == 0
        val label = labelOf(pkg)
        val forceLock = matches(lockList, pkg, label)
        if (!watchAll && !matches(list, pkg, label) && !forceLock) return

        if (System.currentTimeMillis() - since < minutes * 60_000L) return

        val now = System.currentTimeMillis()
        if (overuseHandledPkg == pkg && now - overuseHandledAt < OVERUSE_COOLDOWN_MS) return
        overuseHandledPkg = pkg
        overuseHandledAt = now

        // 单独列为「直接锁定」的应用不看全局动作；其余按 overuseAction。
        if (forceLock || root.optString("overuseAction", "return") == "lock") {
            lockedPkg = pkg
            showOverlay(
                "先歇一会儿",
                root.optString("overuseMessage", "这个应用用太久了，先回小手机歇一会儿吧。"),
                allowSnooze = false,
            )
        } else {
            // 拉回小手机：回到小手机后计时自然重置
            bringToFront()
        }
    }

    // ── 睡眠时段 ──

    /** 当前是否落在睡眠时段内。跨午夜的时段（22:30 → 07:00）也算对。 */
    private fun isSleepWindow(root: JSONObject): Boolean {
        val start = parseMinutes(root.optString("sleepLockStart", "23:00")) ?: return false
        val end = parseMinutes(root.optString("sleepLockEnd", "07:00")) ?: return false
        if (start == end) return false
        val now = Calendar.getInstance()
        val current = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE)
        return if (start <= end) current in start until end else current >= start || current < end
    }

    private fun parseMinutes(text: String): Int? {
        val match = Regex("^(\\d{1,2}):(\\d{2})$").find(text.trim()) ?: return null
        val hour = match.groupValues[1].toIntOrNull() ?: return null
        val minute = match.groupValues[2].toIntOrNull() ?: return null
        if (hour !in 0..23 || minute !in 0..59) return null
        return hour * 60 + minute
    }

    /** 关键词列表是否命中：显示名或包名的包含匹配，不区分大小写。 */
    private fun matches(list: JSONArray?, pkg: String, label: String): Boolean {
        if (list == null) return false
        val labelLower = label.lowercase()
        val pkgLower = pkg.lowercase()
        for (index in 0 until list.length()) {
            val key = list.optString(index, "").trim().lowercase()
            if (key.isNotEmpty() && (labelLower.contains(key) || pkgLower.contains(key))) {
                return true
            }
        }
        return false
    }

    private fun labelOf(pkg: String): String = runCatching {
        val pm = context.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    }.getOrDefault(pkg)

    // ── 遮罩 ──

    /**
     * 显示全屏睡眠遮罩。
     *
     * 用 TYPE_ACCESSIBILITY_OVERLAY：无障碍服务持有这个能力，不需要用户再给
     * 「悬浮窗」权限，也不会被系统当成应用窗口限制。
     */
    private fun showSleepOverlay(message: String) {
        showOverlay("该睡觉了", message, allowSnooze = true)
    }

    /**
     * 全屏遮罩的通用实现。
     *
     * allowSnooze = true 时给一个「再用 5 分钟」的出口（睡眠锁）；
     * 「用太久 → 锁定」不给这个出口——用户要的正是「强行锁定」。
     */
    private fun showOverlay(titleText: String, message: String, allowSnooze: Boolean) {
        mainHandler.post {
            if (overlayView != null) return@post
            val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
                ?: return@post
            val root = LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                setBackgroundColor(0xE6000000.toInt())
                isClickable = true
                // 吃掉所有触摸：让下面的应用收不到点击
                setOnTouchListener { _, _ -> true }
            }

            val title = TextView(context).apply {
                text = titleText
                setTextColor(Color.WHITE)
                textSize = 28f
                typeface = Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
            }
            val body = TextView(context).apply {
                text = message
                setTextColor(0xCCFFFFFF.toInt())
                textSize = 16f
                gravity = Gravity.CENTER
                setPadding(0, dp(14), 0, dp(28))
            }
            val backButton = Button(context).apply {
                text = "回小手机"
                setOnClickListener {
                    postDismiss()
                    bringToFront()
                }
            }
            root.addView(title, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ))
            root.addView(body, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ))
            root.addView(backButton, LinearLayout.LayoutParams(dp(200), dp(48)).apply {
                topMargin = dp(10)
            })
            if (allowSnooze) {
                val snoozeButton = Button(context).apply {
                    text = "再用 5 分钟"
                    setOnClickListener {
                        snoozeUntil = System.currentTimeMillis() + SNOOZE_MS
                        postDismiss()
                    }
                }
                root.addView(snoozeButton, LinearLayout.LayoutParams(dp(200), dp(48)).apply {
                    topMargin = dp(10)
                })
            }

            val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY
            } else {
                @Suppress("DEPRECATION")
                WindowManager.LayoutParams.TYPE_PHONE
            }
            val params = WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                type,
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                    or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                    or WindowManager.LayoutParams.FLAG_FULLSCREEN,
                PixelFormat.TRANSLUCENT,
            ).apply {
                gravity = Gravity.CENTER
            }
            try {
                windowManager.addView(root, params)
                overlayView = root
                overlayShownAt = System.currentTimeMillis()
            } catch (e: Throwable) {
                // 加不上就算了：绝不能因为一个遮罩让无障碍服务崩掉
                overlayView = null
            }
        }
    }

    /** 收起遮罩（可以在任意线程调用）。 */
    private fun postDismiss() {
        mainHandler.post { dismissNow() }
    }

    private fun dismissNow() {
        // 遮罩收起 = 锁定结束；重新进入该应用会重新计时。
        lockedPkg = ""
        val view = overlayView ?: return
        overlayView = null
        overlayShownAt = 0L
        try {
            val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
            windowManager?.removeView(view)
        } catch (e: Throwable) {
            // 视图可能已经被系统移除，忽略
        }
    }

    private fun dp(value: Int): Int =
        (value * context.resources.displayMetrics.density).toInt()
}
