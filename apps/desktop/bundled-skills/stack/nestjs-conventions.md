---
name: nestjs-conventions
description: 任何 NestJS 项目代码（Module / Controller / Service / Pipe / Guard / Interceptor），**调用此技能**遵守 IoC 分层和装饰器规范，避免 Module 循环依赖、Provider 作用域错误等问题。
---

# NestJS 项目规范（10+）

## 适用场景

- 写新 Module / Controller / Service
- 加 Guard / Interceptor / Pipe
- DTO 定义 + 验证
- WebSocket / GraphQL / Microservices
- 测试

## 项目结构（推荐 feature-based）

```
src/
├── main.ts                  # 启动入口
├── app.module.ts            # 根 Module
├── config/                  # ConfigModule + Schema
├── common/                  # 全局 filter / pipe / decorator
├── modules/
│   ├── users/
│   │   ├── users.module.ts
│   │   ├── users.controller.ts
│   │   ├── users.service.ts
│   │   ├── users.repository.ts
│   │   ├── dto/
│   │   │   ├── create-user.dto.ts
│   │   │   └── user.dto.ts
│   │   └── entities/
│   │       └── user.entity.ts
│   └── posts/...
└── infra/                   # 数据库、Redis 等基础设施 Module
```

## 8 条铁律

### 1. 一个 feature 一个 Module

```ts
// users.module.ts
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [UsersController],
  providers: [UsersService, UsersRepository],
  exports: [UsersService],  // 让别的 Module 用
})
export class UsersModule {}
```

❌ 不要把所有路由塞 AppModule
✅ 一个领域一个 Module，AppModule 只组合

### 2. Service 实现业务，Controller 薄

```ts
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @HttpCode(201)
  async create(@Body() dto: CreateUserDto): Promise<UserDto> {
    return this.usersService.create(dto)
  }

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number): Promise<UserDto> {
    return this.usersService.getById(id)
  }
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
  ) {}

  async create(dto: CreateUserDto): Promise<UserDto> {
    const exists = await this.userRepo.findOneBy({ email: dto.email })
    if (exists) throw new ConflictException({ code: 'EMAIL_EXISTS' })

    const user = this.userRepo.create(dto)
    await this.userRepo.save(user)
    return UserDto.from(user)
  }

  async getById(id: number): Promise<UserDto> {
    const user = await this.userRepo.findOneBy({ id })
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND' })
    return UserDto.from(user)
  }
}
```

### 3. DTO 用 class-validator

```ts
import { IsEmail, IsString, MinLength, IsInt, Min, Max, IsOptional } from 'class-validator'

export class CreateUserDto {
  @IsEmail()
  email: string

  @IsString()
  @MinLength(2)
  name: string

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(150)
  age?: number
}
```

启用全局 ValidationPipe：
```ts
// main.ts
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,         // 自动剥除未声明字段
  forbidNonWhitelisted: true,
  transform: true,         // body 转换为 DTO 实例
  transformOptions: { enableImplicitConversion: true },
}))
```

### 4. 异常 — 用内置 HttpException 子类

```ts
throw new BadRequestException({ code: 'VALIDATION_FAILED', message: '...' })
throw new UnauthorizedException()
throw new ForbiddenException()
throw new NotFoundException({ code: 'USER_NOT_FOUND' })
throw new ConflictException({ code: 'EMAIL_EXISTS' })
```

自定义异常：
```ts
export class BusinessException extends HttpException {
  constructor(code: string, message: string, status = 400) {
    super({ code, message }, status)
  }
}
```

全局过滤器统一格式：
```ts
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const response = ctx.getResponse<Response>()
    
    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      const res = exception.getResponse()
      return response.status(status).json(typeof res === 'object' ? res : { message: res })
    }
    
    console.error(exception)
    response.status(500).json({ code: 'INTERNAL_ERROR' })
  }
}

// main.ts
app.useGlobalFilters(new AllExceptionsFilter())
```

### 5. Guard 做鉴权 + 权限

```ts
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>()
    const auth = req.headers.authorization
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedException()
    try {
      req['user'] = await this.jwtService.verifyAsync(auth.slice(7))
      return true
    } catch {
      throw new UnauthorizedException('INVALID_TOKEN')
    }
  }
}

// 用法
@UseGuards(JwtAuthGuard)
@Get('me')
me(@Req() req): UserDto { return req.user }
```

角色：
```ts
@SetMetadata('roles', ['admin'])
@UseGuards(JwtAuthGuard, RolesGuard)
@Delete(':id')
delete(@Param('id') id: number) { ... }
```

### 6. Interceptor 做日志 / 转换 / 缓存

```ts
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler) {
    const req = ctx.switchToHttp().getRequest()
    const start = Date.now()
    return next.handle().pipe(
      tap(() => console.log(`${req.method} ${req.url} - ${Date.now() - start}ms`))
    )
  }
}

// 全局
app.useGlobalInterceptors(new LoggingInterceptor())
```

### 7. 异步 Module + 配置

```ts
// config.module.ts
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        DATABASE_URL: Joi.string().required(),
        JWT_SECRET: Joi.string().min(32).required(),
        PORT: Joi.number().default(3000),
      }),
    }),
  ],
})
export class AppConfigModule {}

// 用配置做异步依赖
TypeOrmModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    type: 'postgres',
    url: config.get('DATABASE_URL'),
    autoLoadEntities: true,
    synchronize: false,  // 生产永远 false，用迁移
  }),
})
```

### 8. 测试 — 单元 + e2e 双管齐下

```ts
// users.service.spec.ts
describe('UsersService', () => {
  let service: UsersService
  let repo: Repository<User>

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOneBy: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
      ],
    }).compile()
    service = module.get(UsersService)
    repo = module.get(getRepositoryToken(User))
  })

  it('throws on duplicate email', async () => {
    jest.spyOn(repo, 'findOneBy').mockResolvedValue({ id: 1 } as User)
    await expect(service.create({ email: 'a@b.com', name: 'A' }))
      .rejects.toThrow(ConflictException)
  })
})

// e2e: test/users.e2e-spec.ts
describe('Users E2E', () => {
  let app: INestApplication

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    await app.init()
  })

  it('POST /users 201', () =>
    request(app.getHttpServer())
      .post('/users')
      .send({ email: 'a@b.com', name: 'Alice' })
      .expect(201)
  )

  afterAll(() => app.close())
})
```

## 常见陷阱

### 陷阱 1：Module 循环依赖

```ts
// users.module 依赖 posts.module，posts.module 依赖 users.module → 报错
// 解决：用 forwardRef
imports: [forwardRef(() => UsersModule)]
```

更好：把共享逻辑抽到第三个 Module（Common），双方都依赖它。

### 陷阱 2：Provider scope 错

```ts
// ❌ 默认 SINGLETON，整个应用共享
@Injectable()
export class RequestContextService {
  userId: string  // 不同请求会互相污染
}

// ✅ REQUEST scope
@Injectable({ scope: Scope.REQUEST })
```

### 陷阱 3：DTO 不会自动校验

```ts
// 没启用 ValidationPipe → 任何字段都过
@Post() create(@Body() dto: CreateUserDto)

// ✅ main.ts 启用全局 ValidationPipe
```

### 陷阱 4：循环依赖在 service 之间

```ts
// 用 forwardRef + inject decorator
@Injectable()
export class A {
  constructor(@Inject(forwardRef(() => B)) private b: B) {}
}
```

但**最好重构掉**，循环依赖说明设计有问题。

## 性能

- 启用 fastify 替代 express：`@nestjs/platform-fastify` 快 30%
- 用 `cache-manager` 给热接口加缓存
- 静态文件用 CDN，不要让 Nest 服务

## 与其他技能的关系

- TypeScript 严格 → typescript-strict-mode
- API 设计 → api-design
- 数据库迁移（TypeORM Migrations） → database-migration-safety
- 安全 → security-best-practices（@nestjs/throttler 限流、helmet）
