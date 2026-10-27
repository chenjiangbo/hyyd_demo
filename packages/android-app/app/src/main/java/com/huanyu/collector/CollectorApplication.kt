package com.huanyu.collector

import android.app.Activity
import android.app.Application
import android.os.Bundle

class CollectorApplication : Application(), Application.ActivityLifecycleCallbacks {
    private val startedActivities = mutableSetOf<Int>()

    override fun onCreate() {
        super.onCreate()
        registerActivityLifecycleCallbacks(this)
        AppPrefs(this).apply {
            appVisibility = "background"
            collectorServiceRunning = false
            syncRunning = false
            backgroundSince = System.currentTimeMillis()
        }
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit

    override fun onActivityStarted(activity: Activity) {
        val wasBackground = startedActivities.isEmpty()
        startedActivities.add(System.identityHashCode(activity))
        if (wasBackground) setAppVisibility(true)
    }

    override fun onActivityResumed(activity: Activity) = Unit

    override fun onActivityPaused(activity: Activity) = Unit

    override fun onActivityStopped(activity: Activity) {
        startedActivities.remove(System.identityHashCode(activity))
        if (startedActivities.isEmpty()) setAppVisibility(false)
    }

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

    override fun onActivityDestroyed(activity: Activity) = Unit

    private fun setAppVisibility(foreground: Boolean) {
        AppPrefs(this).apply {
            appVisibility = if (foreground) "foreground" else "background"
            backgroundSince = if (foreground) 0L else System.currentTimeMillis()
        }
    }
}
