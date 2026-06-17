interface PermissionsMap {
  user: number
  vip: number
  vvip: number
  moderator: number
  admin: number
  superadmin: number
  [key: string]: number
}

interface UserLike {
  permission?: number
}

interface PermissionSelf {
  permissions: Readonly<PermissionsMap>
  keys: readonly string[]
  group: (user: UserLike) => string | null
  is: (user: UserLike, group: string) => boolean
  higher: (user: UserLike, target: UserLike) => boolean
  mapPermissions: (user: UserLike) => Record<string, boolean>
}

const self: PermissionSelf = {} as PermissionSelf

self.permissions = Object.freeze({
  user: 0,
  vip: 5,
  vvip: 10,
  moderator: 50,
  admin: 80,
  superadmin: 100
})

self.keys = Object.freeze(Object.keys(self.permissions))

self.group = (user: UserLike): string | null => {
  for (const key of self.keys) {
    if (user.permission === self.permissions[key]) {
      return key
    }
  }
  return null
}

self.is = (user: UserLike, group: string): boolean => {
  if (typeof group !== 'string' || !group) {
    return false
  }
  const permission = user.permission || 0
  return permission >= self.permissions[group]
}

self.higher = (user: UserLike, target: UserLike): boolean => {
  const userPermission = user.permission || 0
  const targetPermission = target.permission || 0
  return userPermission > targetPermission
}

self.mapPermissions = (user: UserLike): Record<string, boolean> => {
  const map: Record<string, boolean> = {}
  Object.keys(self.permissions).forEach(group => {
    map[group] = self.is(user, group)
  })
  return map
}

export = self
