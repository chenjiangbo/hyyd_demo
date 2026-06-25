plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.huanyu.collector"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.huanyu.collector"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        buildConfigField("String", "BACKEND_URL", "\"http://47.95.14.233:9093\"")
        buildConfigField("String", "EMPLOYEE_CODE", "\"\"")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.work:work-runtime-ktx:2.11.2")
}

kotlin {
    jvmToolchain(17)
}
