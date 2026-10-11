import { useEffect, useRef } from 'react'
import * as THREE from 'three'

type WorldEvent = { name: string; timestamp: number; toolName: string }
export type WorldSession = { id: string; title: string; lastSeen: number | null; recentEvents: WorldEvent[] }
export type WorldProject = { name: string; sessions: WorldSession[]; recentCount: number }
type AgentAction = 'read' | 'edit' | 'command' | 'search' | 'think' | 'respond' | 'error' | 'activity'

const actionLabel: Record<AgentAction, string> = {
  read: 'Reading', edit: 'Editing', command: 'Command', search: 'Searching',
  think: 'Model request', respond: 'Response', error: 'Error', activity: 'Activity',
}
const actionGlow: Record<AgentAction, number> = {
  read: 0x5d9fca, edit: 0x4bd0bb, command: 0xd7a552, search: 0x60b7d8,
  think: 0x9f8bd7, respond: 0x7ec18d, error: 0xd9776e, activity: 0x79b1c0,
}

function actionFor(event: WorldEvent | undefined): AgentAction {
  if (!event) return 'activity'
  if (event.name === 'tool_result') {
    const tool = event.toolName.toLowerCase()
    if (/^(read|grep|glob|ls)$/.test(tool)) return 'read'
    if (/^(edit|write|multiedit|notebookedit)$/.test(tool)) return 'edit'
    if (tool === 'bash') return 'command'
    if (/websearch|webfetch/.test(tool)) return 'search'
    return 'activity'
  }
  if (event.name === 'user_prompt' || event.name === 'api_request') return 'think'
  if (event.name === 'assistant_response' || event.name === 'subagent_completed') return 'respond'
  if (event.name === 'api_error' || event.name === 'api_retries_exhausted') return 'error'
  return 'activity'
}

const eventKey = (event: WorldEvent | undefined) => event ? `${event.timestamp}:${event.name}:${event.toolName}` : ''

type Props = {
  projects: WorldProject[]
  selectedId: string | null
  onSelectSession: (id: string) => void
}

type AgentRig = {
  body: THREE.Group
  head: THREE.Group
  leftArm: THREE.Group
  rightArm: THREE.Group
  paper: THREE.Group
  monitor: THREE.MeshLambertMaterial
  lastSeen: number | null
  lastEventKey: string
  action: AgentAction | null
  actionUntil: number
  phase: number
}

type Runtime = {
  camera: THREE.OrthographicCamera
  target: THREE.Vector3
  desiredTarget: THREE.Vector3
  desiredZoom: number
  overviewZoom: number
  rooms: Map<string, THREE.Vector3>
  anchors: Map<string, THREE.Vector3>
  selectionRings: Map<string, THREE.Mesh>
  rigs: Map<string, AgentRig>
}

const palette = [0x608db0, 0x80a17d, 0xb97968, 0xc7aa60, 0x9683b0, 0x6b9f9a]
const cream = new THREE.MeshLambertMaterial({ color: 0xe5e1d7 })
const floorMaterial = new THREE.MeshLambertMaterial({ color: 0xd9d8d1 })
const floorEdge = new THREE.MeshLambertMaterial({ color: 0xaaaead })
const wood = new THREE.MeshLambertMaterial({ color: 0xc99768 })
const woodSide = new THREE.MeshLambertMaterial({ color: 0x946b4e })
const paperMaterial = new THREE.MeshLambertMaterial({ color: 0xf0e9d8 })
const paperLine = new THREE.MeshLambertMaterial({ color: 0x9ca8a8 })
const screenFrame = new THREE.MeshLambertMaterial({ color: 0x303b40 })
const chairMaterial = new THREE.MeshLambertMaterial({ color: 0x434b50 })
const shirts = [0x397e76, 0x6584a2, 0xa87365, 0x8c785d, 0x777e9a, 0x66856f].map((color) => new THREE.MeshLambertMaterial({ color }))
const skinTones = [0xe0b895, 0xca956f, 0xa87054, 0x7f503d].map((color) => new THREE.MeshLambertMaterial({ color }))
const hairColors = [0x342e2e, 0x694b38, 0x201f22, 0x967350].map((color) => new THREE.MeshLambertMaterial({ color }))
const pantsMaterial = new THREE.MeshLambertMaterial({ color: 0x303b43 })
const ringMaterial = new THREE.MeshBasicMaterial({ color: 0x65bac5, transparent: true, opacity: 0.82, side: THREE.DoubleSide })
const windowGlass = new THREE.MeshLambertMaterial({ color: 0x9bbfd0, emissive: 0x547d91, emissiveIntensity: 0.15 })
const windowFrame = new THREE.MeshLambertMaterial({ color: 0x708790 })

function box(parent: THREE.Object3D, width: number, height: number, depth: number, material: THREE.Material, x: number, y: number, z: number) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material)
  mesh.position.set(x, y, z)
  mesh.castShadow = true
  mesh.receiveShadow = true
  parent.add(mesh)
  return mesh
}

function sphere(parent: THREE.Object3D, radius: number, material: THREE.Material, x: number, y: number, z: number) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), material)
  mesh.position.set(x, y, z)
  mesh.castShadow = true
  parent.add(mesh)
  return mesh
}

function hashId(id: string) {
  let hash = 2166136261
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619)
  return hash >>> 0
}

function arm(parent: THREE.Object3D, material: THREE.Material, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) {
  const start = new THREE.Vector3(x1, y1, z1)
  const end = new THREE.Vector3(x2, y2, z2)
  const direction = end.clone().sub(start)
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, direction.length(), 8), material)
  mesh.position.copy(start.add(end).multiplyScalar(0.5))
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize())
  mesh.castShadow = true
  parent.add(mesh)
}

function addPerson(room: THREE.Group, session: WorldSession, x: number, z: number, facesBack: boolean, rings: Map<string, THREE.Mesh>) {
  const identity = hashId(session.id)
  const shirt = shirts[identity % shirts.length]
  const skin = skinTones[(identity >>> 4) % skinTones.length]
  const hairColor = hairColors[(identity >>> 8) % hairColors.length]
  const person = new THREE.Group()
  person.position.set(x, 0, z)
  person.rotation.y = facesBack ? Math.PI : 0
  person.userData.sessionId = session.id
  room.add(person)

  box(person, 0.55, 0.16, 0.55, chairMaterial, 0, 0.48, -0.16)
  box(person, 0.58, 0.68, 0.13, chairMaterial, 0, 0.84, -0.49)
  box(person, 0.08, 0.42, 0.08, chairMaterial, 0, 0.25, -0.16)
  box(person, 0.55, 0.07, 0.07, chairMaterial, 0, 0.06, -0.16)
  box(person, 0.12, 0.28, 0.19, pantsMaterial, -0.17, 0.42, 0.22)
  box(person, 0.12, 0.28, 0.19, pantsMaterial, 0.17, 0.42, 0.22)
  const body = new THREE.Group()
  person.add(body)
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.28, 0.55, 10), shirt)
  torso.position.set(0, 0.91, -0.1)
  torso.castShadow = true
  body.add(torso)
  const head = new THREE.Group()
  head.position.set(0, 1.22, -0.07)
  body.add(head)
  sphere(head, 0.255, skin, 0, 0.2, 0)
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.263 + (identity % 3) * 0.012, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), hairColor)
  hair.position.set(0, 0.23, 0)
  hair.castShadow = true
  head.add(hair)
  const leftArm = new THREE.Group()
  leftArm.position.set(-0.24, 1.08, 0.02)
  arm(leftArm, shirt, 0, 0, 0, 0.02, -0.28, 0.37)
  sphere(leftArm, 0.085, skin, 0.02, -0.28, 0.37)
  body.add(leftArm)
  const rightArm = new THREE.Group()
  rightArm.position.set(0.24, 1.08, 0.02)
  arm(rightArm, shirt, 0, 0, 0, -0.02, -0.28, 0.37)
  sphere(rightArm, 0.085, skin, -0.02, -0.28, 0.37)
  body.add(rightArm)
  const paper = new THREE.Group()
  paper.position.set(0, 0.855, 0.63)
  box(paper, 0.38, 0.016, 0.43, paperMaterial, 0, 0, 0)
  box(paper, 0.25, 0.018, 0.014, paperLine, -0.015, 0.012, -0.08)
  box(paper, 0.21, 0.018, 0.014, paperLine, -0.035, 0.012, 0.01)
  paper.visible = false
  person.add(paper)

  const ring = new THREE.Mesh(new THREE.RingGeometry(0.38, 0.44, 32), ringMaterial)
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.015
  ring.visible = false
  person.add(ring)
  rings.set(session.id, ring)
  return { body, head, leftArm, rightArm, paper }
}

function addMonitor(room: THREE.Group, x: number, z: number, facesBack: boolean) {
  const glass = new THREE.MeshLambertMaterial({ color: 0x719cad, emissive: 0x3b8c9c, emissiveIntensity: 0.1 })
  box(room, 0.62, 0.42, 0.07, screenFrame, x, 1.07, z)
  box(room, 0.53, 0.32, 0.012, glass, x, 1.08, z + (facesBack ? 0.042 : -0.042))
  box(room, 0.05, 0.22, 0.05, screenFrame, x, 0.81, z)
  box(room, 0.38, 0.025, 0.17, screenFrame, x, 0.765, z + (facesBack ? 0.35 : -0.35))
  return glass
}

function addWindow(room: THREE.Group, x: number, y: number, z: number, onBackWall: boolean) {
  if (onBackWall) {
    box(room, 1.75, 1.05, 0.07, windowFrame, x, y, z)
    box(room, 1.56, 0.86, 0.08, windowGlass, x, y, z + 0.05)
    box(room, 0.055, 0.95, 0.12, windowFrame, x, y, z + 0.1)
  } else {
    box(room, 0.07, 1.05, 1.75, windowFrame, x, y, z)
    box(room, 0.08, 0.86, 1.56, windowGlass, x + 0.05, y, z)
    box(room, 0.12, 0.95, 0.055, windowFrame, x + 0.1, y, z)
  }
}

function addRoom(project: WorldProject, index: number, position: THREE.Vector3, rings: Map<string, THREE.Mesh>, anchors: Map<string, THREE.Vector3>, rigs: Map<string, AgentRig>) {
  const room = new THREE.Group()
  room.position.copy(position)
  room.userData.projectName = project.name
  const width = Math.max(9.2, Math.ceil(project.sessions.length / 2) * 1.3 + 2.8)
  const depth = 7.6
  const accent = new THREE.MeshLambertMaterial({ color: palette[index % palette.length] })
  const wallLow = new THREE.MeshLambertMaterial({ color: 0xc4c5bd })

  box(room, width, 0.28, depth, floorMaterial, 0, -0.14, 0)
  box(room, width, 0.24, depth, floorEdge, 0, -0.36, 0)
  box(room, width, 2.55, 0.18, accent, 0, 1.28, -depth / 2)
  box(room, 0.18, 2.55, depth, cream, -width / 2, 1.28, 0)
  box(room, width, 0.62, 0.18, wallLow, 0, 0.31, depth / 2)
  box(room, 0.18, 0.62, depth, wallLow, width / 2, 0.31, 0)
  box(room, width, 0.13, 0.28, cream, 0, 2.58, -depth / 2)
  box(room, 0.28, 0.13, depth, cream, -width / 2, 2.58, 0)
  addWindow(room, -width * 0.23, 1.65, -depth / 2 + 0.13, true)
  addWindow(room, width * 0.22, 1.65, -depth / 2 + 0.13, true)
  addWindow(room, -width / 2 + 0.13, 1.65, 0.1, false)

  const seatsPerSide = Math.ceil(project.sessions.length / 2)
  const tableLength = Math.max(3.6, seatsPerSide * 1.25 + 0.7)
  box(room, tableLength, 0.18, 2.1, wood, 0, 0.75, 0)
  box(room, tableLength, 0.18, 0.11, woodSide, 0, 0.61, 1.05)
  box(room, tableLength, 0.18, 0.11, woodSide, 0, 0.61, -1.05)
  for (const x of [-tableLength / 2 + 0.23, tableLength / 2 - 0.23]) {
    for (const z of [-0.83, 0.83]) box(room, 0.18, 0.66, 0.18, woodSide, x, 0.33, z)
  }
  project.sessions.forEach((session, seat) => {
    const far = seat % 2 === 0
    const sideIndex = Math.floor(seat / 2)
    const x = (sideIndex - (seatsPerSide - 1) / 2) * 1.25
    const z = far ? -1.75 : 1.75
    const person = addPerson(room, session, x, z, !far, rings)
    anchors.set(session.id, new THREE.Vector3(position.x + x, 1.93, position.z + z))
    const monitor = addMonitor(room, x, far ? -0.47 : 0.47, far)
    rigs.set(session.id, { ...person, monitor, lastSeen: session.lastSeen, lastEventKey: '', action: null, actionUntil: 0, phase: index * 2.1 + seat * 1.3 })
  })
  room.traverse((child) => {
    if (child instanceof THREE.Mesh && !child.userData.sessionId) child.userData.projectName = project.name
  })
  return { room, width }
}

function addTree(parent: THREE.Object3D, x: number, z: number) {
  const trunk = new THREE.MeshLambertMaterial({ color: 0x795f48 })
  const leaves = new THREE.MeshLambertMaterial({ color: 0x6b945b })
  box(parent, 0.22, 0.78, 0.22, trunk, x, 0.39, z)
  box(parent, 0.85, 0.8, 0.85, leaves, x, 1.12, z)
  box(parent, 0.55, 0.46, 0.55, leaves, x + 0.18, 1.62, z - 0.07)
}

export default function OfficeWorldCanvas({ projects, selectedId, onSelectSession }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const runtimeRef = useRef<Runtime | null>(null)
  const callbackRef = useRef(onSelectSession)
  callbackRef.current = onSelectSession
  const signature = projects.map((project) => `${project.name}:${project.sessions.map((session) => session.id).join(',')}`).join('|')
  const signalSignature = projects.flatMap((project) => project.sessions.map((session) => `${session.id}:${session.lastSeen ?? ''}:${eventKey(session.recentEvents[0])}`)).join('|')

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0xaeb8c3)
    const camera = new THREE.OrthographicCamera(-15, 15, 15, -15, 0.1, 200)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFShadowMap
    renderer.outputColorSpace = THREE.SRGBColorSpace
    host.prepend(renderer.domElement)
    renderer.domElement.className = 'office-three-canvas'
    scene.add(new THREE.AmbientLight(0xffffff, 1.5))
    const sunlight = new THREE.DirectionalLight(0xfff3df, 2.15)
    sunlight.position.set(-8, 14, 9)
    sunlight.castShadow = true
    sunlight.shadow.mapSize.set(1024, 1024)
    sunlight.shadow.camera.left = -35
    sunlight.shadow.camera.right = 35
    sunlight.shadow.camera.top = 35
    sunlight.shadow.camera.bottom = -35
    sunlight.shadow.normalBias = 0.025
    scene.add(sunlight)

    const columns = Math.max(1, Math.ceil(Math.sqrt(projects.length)))
    const rows = Math.max(1, Math.ceil(projects.length / columns))
    const maxWidth = Math.max(9.2, ...projects.map((project) => Math.ceil(project.sessions.length / 2) * 1.3 + 2.8))
    const stepX = maxWidth + 3.2
    const stepZ = 10.8
    const rooms = new Map<string, THREE.Vector3>()
    const anchors = new Map<string, THREE.Vector3>()
    const selectionRings = new Map<string, THREE.Mesh>()
    const rigs = new Map<string, AgentRig>()
    const groundWidth = columns * stepX + 4
    const groundDepth = rows * stepZ + 4
    const groundMaterial = new THREE.MeshLambertMaterial({ color: 0xb9c2c8 })
    box(scene, groundWidth, 0.08, groundDepth, groundMaterial, 0, -0.52, 0)
    const pathMaterial = new THREE.MeshLambertMaterial({ color: 0xd0d3ce })
    if (columns > 1) box(scene, 1.9, 0.05, groundDepth, pathMaterial, 0, -0.455, 0)
    if (rows > 1) box(scene, groundWidth, 0.05, 1.7, pathMaterial, 0, -0.45, 0)
    projects.forEach((project, index) => {
      const column = index % columns
      const row = Math.floor(index / columns)
      const position = new THREE.Vector3((column - (columns - 1) / 2) * stepX, 0, (row - (rows - 1) / 2) * stepZ)
      rooms.set(project.name, position)
      const { room, width } = addRoom(project, index, position, selectionRings, anchors, rigs)
      scene.add(room)
      const treeGroup = new THREE.Group()
      addTree(treeGroup, position.x - width / 2 - 1.1, position.z - 2.5)
      addTree(treeGroup, position.x + width / 2 + 1.15, position.z + 2.2)
      scene.add(treeGroup)
    })

    const target = new THREE.Vector3()
    const aspect = host.clientWidth / Math.max(1, host.clientHeight)
    const overviewZoom = Math.min(1.15, 29 / (rows * stepZ + 7), 29 * aspect / (columns * stepX + 7))
    const runtime: Runtime = { camera, target, desiredTarget: target.clone(), desiredZoom: overviewZoom, overviewZoom, rooms, anchors, selectionRings, rigs }
    runtimeRef.current = runtime
    camera.position.set(22, 24, 28)
    camera.lookAt(target)
    camera.zoom = overviewZoom
    camera.updateProjectionMatrix()

    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const pointerPosition = (clientX: number, clientY: number) => {
      const bounds = renderer.domElement.getBoundingClientRect()
      pointer.x = ((clientX - bounds.left) / bounds.width) * 2 - 1
      pointer.y = -((clientY - bounds.top) / bounds.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
    }
    const groundAt = (clientX: number, clientY: number) => {
      pointerPosition(clientX, clientY)
      return raycaster.ray.intersectPlane(groundPlane, new THREE.Vector3())
    }
    const identify = (event: PointerEvent) => {
      pointerPosition(event.clientX, event.clientY)
      for (const hit of raycaster.intersectObjects(scene.children, true)) {
        let object: THREE.Object3D | null = hit.object
        while (object) {
          if (object.userData.sessionId) return object.userData.sessionId as string
          object = object.parent
        }
      }
      return null
    }
    let drag: { id: number; x: number; y: number; startX: number; startY: number; moved: boolean } | null = null
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false }
      renderer.domElement.setPointerCapture(event.pointerId)
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) {
        renderer.domElement.style.cursor = identify(event) ? 'pointer' : 'grab'
        return
      }
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) drag.moved = true
      if (drag.moved) {
        const previous = groundAt(drag.x, drag.y)
        const current = groundAt(event.clientX, event.clientY)
        if (previous && current) {
          runtime.desiredTarget.add(previous.sub(current))
          runtime.target.copy(runtime.desiredTarget)
        }
        renderer.domElement.style.cursor = 'grabbing'
      }
      drag.x = event.clientX
      drag.y = event.clientY
    }
    const onPointerUp = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return
      const moved = drag.moved
      drag = null
      renderer.domElement.style.cursor = 'grab'
      if (!moved) {
        const sessionId = identify(event)
        if (sessionId) callbackRef.current(sessionId)
      }
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const before = groundAt(event.clientX, event.clientY)
      const nextZoom = THREE.MathUtils.clamp(runtime.desiredZoom * Math.exp(-event.deltaY * 0.001), runtime.overviewZoom * 0.7, 5)
      runtime.desiredZoom = nextZoom
      camera.zoom = nextZoom
      camera.updateProjectionMatrix()
      const after = groundAt(event.clientX, event.clientY)
      if (before && after) {
        runtime.desiredTarget.add(before.sub(after))
        runtime.target.copy(runtime.desiredTarget)
      }
    }
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointermove', onPointerMove)
    renderer.domElement.addEventListener('pointerup', onPointerUp)
    renderer.domElement.addEventListener('pointercancel', onPointerUp)
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false })

    const resize = () => {
      const width = host.clientWidth
      const height = host.clientHeight
      if (!width || !height) return
      renderer.setSize(width, height, false)
      const aspect = width / height
      camera.left = -15 * aspect
      camera.right = 15 * aspect
      camera.top = 15
      camera.bottom = -15
      camera.updateProjectionMatrix()
      runtime.overviewZoom = Math.min(1.15, 29 / (rows * stepZ + 7), 29 * aspect / (columns * stepX + 7))
      runtime.desiredZoom = Math.max(runtime.desiredZoom, runtime.overviewZoom * 0.7)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()

    let frame = 0
    const labelPoint = new THREE.Vector3()
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const render = () => {
      frame = window.requestAnimationFrame(render)
      const moment = performance.now()
      const now = Date.now()
      runtime.target.lerp(runtime.desiredTarget, 0.11)
      camera.position.copy(runtime.target).add(new THREE.Vector3(22, 24, 28))
      camera.lookAt(runtime.target)
      camera.zoom += (runtime.desiredZoom - camera.zoom) * 0.11
      camera.updateProjectionMatrix()
      runtime.rigs.forEach((rig) => {
        const age = rig.lastSeen === null ? Infinity : now - rig.lastSeen
        const recent = age >= 0 && age <= 120_000
        const action = moment < rig.actionUntil ? rig.action : null
        const time = moment / 1000
        rig.paper.visible = action === 'read'
        if (reducedMotion.matches) {
          rig.body.position.y = 0
          rig.body.rotation.set(0, 0, 0)
          rig.head.rotation.set(0, 0, 0)
          rig.leftArm.rotation.x = 0
          rig.rightArm.rotation.x = 0
        } else {
          rig.body.position.y = 0.012 * Math.sin(time * 1.6 + rig.phase)
          rig.body.rotation.z = 0.012 * Math.sin(time * 0.8 + rig.phase)
          rig.body.rotation.x = action === 'edit' || action === 'command' ? 0.035 : action === 'think' ? -0.025 : 0
          rig.head.rotation.x = action === 'read' ? 0.17 : action === 'think' ? -0.13 : action === 'respond' ? 0.07 * Math.sin(time * 6) : 0
          rig.head.rotation.z = action === 'error' ? 0.13 : action === 'search' ? 0.06 * Math.sin(time * 2.5) : 0
          rig.leftArm.rotation.x = action === 'edit' ? 0.13 * Math.sin(time * 14 + rig.phase) : action === 'read' ? -0.15 : 0
          rig.rightArm.rotation.x = action === 'edit' ? 0.13 * Math.sin(time * 14 + rig.phase + Math.PI) : action === 'command' ? 0.18 * Math.sin(time * 9 + rig.phase) : action === 'search' ? -0.13 : 0
        }
        rig.monitor.emissive.setHex(action ? actionGlow[action] : 0x3b8c9c)
        rig.monitor.emissiveIntensity = action ? 0.52 + (reducedMotion.matches ? 0 : 0.12 * Math.sin(time * 7 + rig.phase)) : recent ? 0.36 : 0.1
      })
      for (const label of host.querySelectorAll<HTMLElement>('[data-office-world-label]')) {
        const kind = label.dataset.officeWorldLabel
        const id = label.dataset.officeWorldId
        const roomPosition = rooms.get(id || '')
        if (kind === 'project' && roomPosition) labelPoint.copy(roomPosition).add(new THREE.Vector3(0, 3.45, -2.5))
        else if (kind === 'session' && id && anchors.has(id)) labelPoint.copy(anchors.get(id)!)
        else continue
        label.style.visibility = kind === 'session' && camera.zoom < 1.6 ? 'hidden' : 'visible'
        if (kind === 'session') {
          const rig = runtime.rigs.get(id || '')
          const action = rig && moment < rig.actionUntil ? rig.action : null
          const nextLabel = action ? actionLabel[action] : ''
          if (label.dataset.action !== nextLabel) label.dataset.action = nextLabel
          if (label.dataset.actionKind !== (action || '')) label.dataset.actionKind = action || ''
        }
        labelPoint.project(camera)
        label.style.left = `${(labelPoint.x + 1) * 50}%`
        label.style.top = `${(1 - labelPoint.y) * 50}%`
      }
      renderer.render(scene, camera)
    }
    render()
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      renderer.domElement.removeEventListener('pointercancel', onPointerUp)
      renderer.domElement.removeEventListener('wheel', onWheel)
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) object.geometry.dispose()
      })
      rigs.forEach((rig) => rig.monitor.dispose())
      groundMaterial.dispose()
      pathMaterial.dispose()
      renderer.dispose()
      renderer.domElement.remove()
      runtimeRef.current = null
    }
  }, [signature])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.selectionRings.forEach((ring, id) => { ring.visible = id === selectedId })
  }, [selectedId, signature])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    projects.forEach((project) => project.sessions.forEach((session) => {
      const rig = runtime.rigs.get(session.id)
      if (!rig) return
      const latest = session.recentEvents[0]
      const nextEventKey = eventKey(latest)
      const eventAge = latest ? Date.now() - latest.timestamp : Infinity
      const signalAge = session.lastSeen === null ? Infinity : Date.now() - session.lastSeen
      if (nextEventKey !== rig.lastEventKey && eventAge >= 0 && eventAge < 30_000) {
        rig.action = actionFor(latest)
        rig.actionUntil = performance.now() + 5_000
      } else if (session.lastSeen !== null && (rig.lastSeen === null || session.lastSeen > rig.lastSeen) && signalAge >= 0 && signalAge < 30_000) {
        rig.action = 'activity'
        rig.actionUntil = performance.now() + 4_000
      }
      rig.lastEventKey = nextEventKey
      rig.lastSeen = session.lastSeen
    }))
  }, [signalSignature, signature])

  const zoom = (factor: number) => {
    const runtime = runtimeRef.current
    if (runtime) runtime.desiredZoom = THREE.MathUtils.clamp(runtime.desiredZoom * factor, runtime.overviewZoom * 0.7, 5)
  }
  const fitAll = () => {
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.desiredTarget.set(0, 0, 0)
    runtime.desiredZoom = runtime.overviewZoom
  }
  const focusOffice = (project: WorldProject) => {
    const runtime = runtimeRef.current
    const room = runtime?.rooms.get(project.name)
    if (!runtime || !room) return
    const width = Math.max(9.2, Math.ceil(project.sessions.length / 2) * 1.3 + 2.8)
    const aspect = (runtime.camera.right - runtime.camera.left) / (runtime.camera.top - runtime.camera.bottom)
    runtime.desiredTarget.copy(room)
    runtime.desiredTarget.y += 0.2
    runtime.desiredZoom = Math.min(2.5, 30 * aspect / (width + 3.2), 30 / (7.6 + 3.2))
  }

  return <div className="office-three-host" ref={hostRef}>
    <div className="office-world-label-layer">
      {projects.map((project) => <button type="button" key={project.name} data-office-world-label="project" data-office-world-id={project.name} className="office-world-label project" onClick={() => focusOffice(project)} title={`Focus on ${project.name}`}>{project.name}<small>{project.sessions.length} {project.sessions.length === 1 ? 'session' : 'sessions'}</small></button>)}
      {projects.flatMap((project) => project.sessions.map((session) => {
        const recent = session.lastSeen !== null && Date.now() - session.lastSeen <= 120_000
        return <button type="button" key={session.id} data-office-world-label="session" data-office-world-id={session.id} data-action="" data-action-kind="" className={`office-world-label session${selectedId === session.id ? ' selected' : ''}${recent ? ' recent' : ''}`} onClick={() => onSelectSession(session.id)} title={recent ? `${session.title} · recent telemetry` : session.title}><span className="office-world-title">{session.title}</span></button>
      }))}
    </div>
    <div className="office-map-controls" aria-label="Map controls"><button type="button" onClick={() => zoom(1.3)} aria-label="Zoom in">+</button><button type="button" onClick={() => zoom(1 / 1.3)} aria-label="Zoom out">−</button><button type="button" onClick={fitAll}>Fit all</button></div>
  </div>
}
