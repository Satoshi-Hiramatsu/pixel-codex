plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "jp.pixelcodex.companion"
    compileSdk = 36

    defaultConfig {
        applicationId = "jp.pixelcodex.companion"
        minSdk = 26
        targetSdk = 36
        versionCode = 4
        versionName = "0.3.0"
    }

    buildFeatures {
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.05.00")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.10.0")
    implementation("com.squareup.okhttp3:okhttp:5.3.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")

    debugImplementation("androidx.compose.ui:ui-tooling")
}
