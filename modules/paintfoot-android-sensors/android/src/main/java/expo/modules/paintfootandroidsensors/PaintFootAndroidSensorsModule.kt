package expo.modules.paintfootandroidsensors

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.TriggerEvent
import android.hardware.TriggerEventListener
import android.os.Bundle
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.math.PI

private const val SENSOR_EVENT = "onSensorChanged"
private const val ACCURACY_EVENT = "onSensorAccuracyChanged"

class PaintFootAndroidSensorsModule : Module(), SensorEventListener {
  private data class SensorSpec(val id: String, val type: Int)

  private val sensorSpecs = listOf(
    SensorSpec("proximity", Sensor.TYPE_PROXIMITY),
    SensorSpec("gravity", Sensor.TYPE_GRAVITY),
    SensorSpec("linearAcceleration", Sensor.TYPE_LINEAR_ACCELERATION),
    SensorSpec("rotationVector", Sensor.TYPE_ROTATION_VECTOR),
    SensorSpec("gameRotationVector", Sensor.TYPE_GAME_ROTATION_VECTOR),
    SensorSpec("geomagneticRotationVector", Sensor.TYPE_GEOMAGNETIC_ROTATION_VECTOR),
    SensorSpec("stepDetector", Sensor.TYPE_STEP_DETECTOR),
    SensorSpec("significantMotion", Sensor.TYPE_SIGNIFICANT_MOTION),
  )

  private val sensorManager: SensorManager
    get() {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      return context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    }

  private val registeredSensors = mutableListOf<Sensor>()
  private var significantMotionSensor: Sensor? = null
  private var running = false
  private var enabledIds = emptySet<String>()

  private val significantMotionListener = object : TriggerEventListener() {
    override fun onTrigger(event: TriggerEvent) {
      sendSensorEvent(event.sensor, event.values, event.timestamp, true)
      if (running && enabledIds.contains("significantMotion")) {
        armSignificantMotion()
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("PaintFootAndroidSensors")

    Events(SENSOR_EVENT, ACCURACY_EVENT)

    AsyncFunction("getCapabilitiesAsync") {
      sensorSpecs.map { capabilityFor(it) }
    }

    AsyncFunction("startAsync") { sensorIds: List<String>, updateIntervalMs: Int ->
      startSensors(sensorIds.toSet(), updateIntervalMs)
    }

    AsyncFunction("stopAsync") {
      stopSensors()
    }

    OnDestroy {
      stopSensors()
    }
  }

  private fun capabilityFor(spec: SensorSpec): Map<String, Any?> {
    val sensor = sensorManager.getDefaultSensor(spec.type)
    return if (sensor == null) {
      mapOf(
        "id" to spec.id,
        "androidType" to spec.type,
        "available" to false,
      )
    } else {
      mapOf(
        "id" to spec.id,
        "androidType" to spec.type,
        "available" to true,
        "name" to sensor.name,
        "vendor" to sensor.vendor,
        "version" to sensor.version,
        "powerMa" to sensor.power.toDouble(),
        "resolution" to sensor.resolution.toDouble(),
        "maximumRange" to sensor.maximumRange.toDouble(),
        "reportingMode" to sensor.reportingMode,
        "wakeUpSensor" to sensor.isWakeUpSensor,
      )
    }
  }

  private fun startSensors(sensorIds: Set<String>, updateIntervalMs: Int): List<String> {
    stopSensors()
    running = true
    enabledIds = sensorIds
    val intervalMicroseconds = updateIntervalMs.coerceIn(20, 5_000) * 1_000
    val activeIds = mutableListOf<String>()

    sensorSpecs.forEach { spec ->
      if (!sensorIds.contains(spec.id)) return@forEach
      val sensor = sensorManager.getDefaultSensor(spec.type) ?: return@forEach
      if (spec.type == Sensor.TYPE_SIGNIFICANT_MOTION) {
        significantMotionSensor = sensor
        if (armSignificantMotion()) activeIds.add(spec.id)
      } else if (sensorManager.registerListener(this, sensor, intervalMicroseconds)) {
        registeredSensors.add(sensor)
        activeIds.add(spec.id)
      }
    }
    return activeIds
  }

  private fun stopSensors() {
    val manager = appContext.reactContext?.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
    if (manager != null) {
      manager.unregisterListener(this)
      significantMotionSensor?.let {
        manager.cancelTriggerSensor(significantMotionListener, it)
      }
    }
    registeredSensors.clear()
    significantMotionSensor = null
    enabledIds = emptySet()
    running = false
  }

  private fun armSignificantMotion(): Boolean {
    val sensor = significantMotionSensor ?: return false
    return sensorManager.requestTriggerSensor(significantMotionListener, sensor)
  }

  override fun onSensorChanged(event: SensorEvent) {
    sendSensorEvent(event.sensor, event.values, event.timestamp, false)
  }

  override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) {
    val spec = sensorSpecs.firstOrNull { it.type == sensor.type } ?: return
    sendEvent(
      ACCURACY_EVENT,
      Bundle().apply {
        putString("id", spec.id)
        putInt("accuracy", accuracy)
        putDouble("timestamp", System.currentTimeMillis().toDouble())
      },
    )
  }

  private fun sendSensorEvent(
    sensor: Sensor,
    values: FloatArray,
    timestampNanoseconds: Long,
    triggered: Boolean,
  ) {
    val spec = sensorSpecs.firstOrNull { it.type == sensor.type } ?: return
    val headingDegrees = if (
      sensor.type == Sensor.TYPE_ROTATION_VECTOR ||
      sensor.type == Sensor.TYPE_GAME_ROTATION_VECTOR ||
      sensor.type == Sensor.TYPE_GEOMAGNETIC_ROTATION_VECTOR
    ) {
      rotationHeadingDegrees(values)
    } else {
      null
    }

    sendEvent(
      SENSOR_EVENT,
      Bundle().apply {
        putString("id", spec.id)
        putDoubleArray("values", values.map { it.toDouble() }.toDoubleArray())
        putDouble("timestamp", timestampNanoseconds / 1_000_000.0)
        putDouble("maximumRange", sensor.maximumRange.toDouble())
        putBoolean("triggered", triggered)
        headingDegrees?.let { putDouble("headingDegrees", it) }
        if (sensor.type == Sensor.TYPE_PROXIMITY) {
          putBoolean("near", values.firstOrNull()?.let { it < sensor.maximumRange } ?: false)
        }
      },
    )
  }

  private fun rotationHeadingDegrees(values: FloatArray): Double? {
    return try {
      val rotationMatrix = FloatArray(9)
      val orientation = FloatArray(3)
      SensorManager.getRotationMatrixFromVector(rotationMatrix, values)
      SensorManager.getOrientation(rotationMatrix, orientation)
      ((orientation[0] * 180.0 / PI) + 360.0) % 360.0
    } catch (_: RuntimeException) {
      null
    }
  }
}
